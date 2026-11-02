// Dragonwilds Server Kit: native module loaded into the dedicated server through LD_PRELOAD.
// Refuses to run on any other build of the server. Commands arrive on a local Unix socket as
//   id <TAB> command <TAB> arg...
// and are executed on the game thread, inside the engine tick. Replies are one JSON line each.
#include <elf.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

#include "reflect.h"
#include "ue.h"

namespace {

using TickFn = void (*)(void*, float, bool);
using GetGameWorldFn = void* (*)(void*);

constexpr int kMaxCommandsPerFrame = 32;
constexpr size_t kMaxLine = 64 * 1024;

struct Client {
    int fd;
    std::string in;
    std::string out;
};

TickFn g_orig_tick = nullptr;
std::string g_dir;
FILE* g_log = nullptr;
int g_listen = -1;
std::vector<Client> g_clients;
void* g_engine = nullptr;
float g_fps = 0;

void logf(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char buf[1024];
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    fprintf(stderr, "[DWKit] %s\n", buf);
    if (g_log) {
        fprintf(g_log, "%s\n", buf);
        fflush(g_log);
    }
}

void* game_world() { return g_engine ? reinterpret_cast<GetGameWorldFn>(ue::kAddrGetGameWorld)(g_engine) : nullptr; }

std::string call_or_null(void* obj, const char* func) {
    if (!obj) return "null";
    std::string err;
    std::string r = reflect::call(obj, func, {}, err);
    return err.empty() ? r : "null";
}

std::string player_json(void* ps) {
    std::string out = "{\"ps\":" + reflect::json_str(reflect::ptr_str(ps));
    out += ",\"name\":" + reflect::get_json(ps, "PlayerNamePrivate");
    void* id_prop = reflect::find_property(ue::at<void*>(ps, ue::kObjClass), "UniqueID");
    out += ",\"id\":" + reflect::json_str(id_prop ? reflect::net_id_string(static_cast<char*>(ps) + ue::at<int32_t>(id_prop, ue::kPropOffset)) : "");
    out += ",\"ping\":" + reflect::get_json(ps, "CompressedPing");
    out += ",\"address\":" + reflect::get_json(ps, "SavedNetworkAddress");
    void* pc = reflect::get_object(ps, "Owner");
    void* pawn = reflect::get_object(ps, "PawnPrivate");
    out += ",\"pc\":" + reflect::json_str(reflect::ptr_str(pc));
    out += ",\"pawn\":" + reflect::json_str(reflect::ptr_str(pawn));
    if (pawn) {
        out += ",\"location\":" + call_or_null(pawn, "K2_GetActorLocation");
        out += ",\"rotation\":" + call_or_null(pawn, "K2_GetActorRotation");
        void* health = reflect::get_object(pawn, "HealthComponent");
        void* stamina = reflect::get_object(pawn, "StaminaComponent");
        out += ",\"healthComp\":" + reflect::json_str(reflect::ptr_str(health));
        out += ",\"staminaComp\":" + reflect::json_str(reflect::ptr_str(stamina));
        out += ",\"health\":" + call_or_null(health, "GetAuthoritativeHealth");
        out += ",\"maxHealth\":" + call_or_null(health, "GetMaxHealth");
        out += ",\"dead\":" + call_or_null(health, "IsDead");
        out += ",\"stamina\":" + call_or_null(stamina, "GetStamina");
        out += ",\"maxStamina\":" + call_or_null(stamina, "GetMaxStamina");
    }
    return out + "}";
}

std::string snapshot_json() {
    void* world = game_world();
    std::string out = "{\"world\":" + reflect::json_str(reflect::obj_name(world));
    char fps[32];
    snprintf(fps, sizeof fps, "%.1f", g_fps);
    out += ",\"fps\":" + std::string(fps) + ",\"players\":[";
    void* gs = world ? reflect::get_object(world, "GameState") : nullptr;
    void* arr = gs ? reflect::find_property(ue::at<void*>(gs, ue::kObjClass), "PlayerArray") : nullptr;
    if (arr) {
        char* base = static_cast<char*>(gs) + ue::at<int32_t>(arr, ue::kPropOffset);
        void** data = *reinterpret_cast<void***>(base);
        int num = *reinterpret_cast<int32_t*>(base + 8);
        for (int i = 0; i < num; ++i) {
            if (i) out += ",";
            out += player_json(data[i]);
        }
    }
    return out + "]}";
}

std::string instances_json(const std::string& cls, int limit) {
    std::string out = "[";
    bool first = true;
    for (void* o : reflect::find_instances(cls, limit)) {
        if (!first) out += ",";
        first = false;
        out += reflect::obj_json(o);
    }
    return out + "]";
}

// Returns the "result" JSON, or sets err.
std::string run_command(const std::vector<std::string>& a, std::string& err) {
    const std::string& cmd = a[1];
    size_t argc = a.size() - 2;
    auto arg = [&](size_t i) -> const std::string& { return a[i + 2]; };
    auto need_obj = [&](size_t i) -> void* {
        void* o = argc > i ? reflect::parse_obj(arg(i)) : nullptr;
        if (!o) err = "invalid object";
        return o;
    };

    if (cmd == "ping") return "\"pong\"";
    if (cmd == "snapshot") return snapshot_json();
    if (cmd == "world") return reflect::obj_json(game_world());
    if (cmd == "find") {
        if (argc < 1) { err = "find <class> [limit]"; return ""; }
        return instances_json(arg(0), argc > 1 ? atoi(arg(1).c_str()) : 200);
    }
    if (cmd == "named") {
        if (argc < 1) { err = "named <object> [class]"; return ""; }
        return reflect::obj_json(reflect::find_named(arg(0), argc > 1 ? arg(1) : ""));
    }
    if (cmd == "cdo") {
        if (argc < 1) { err = "cdo <class>"; return ""; }
        return reflect::obj_json(reflect::default_object(arg(0)));
    }
    if (cmd == "load") {
        if (argc < 1) { err = "load <path>"; return ""; }
        return reflect::obj_json(reflect::load_object(arg(0)));
    }
    if (cmd == "get") {
        void* o = need_obj(0);
        if (!o) return "";
        if (argc < 2) { err = "get <obj> <prop>"; return ""; }
        return reflect::get_json(o, arg(1).c_str());
    }
    if (cmd == "set") {
        void* o = need_obj(0);
        if (!o) return "";
        if (argc < 3) { err = "set <obj> <prop> <value>"; return ""; }
        return reflect::set_value(o, arg(1).c_str(), arg(2), err) ? "true" : "";
    }
    if (cmd == "call") {
        void* o = need_obj(0);
        if (!o) return "";
        if (argc < 2) { err = "call <obj> <func> [args]"; return ""; }
        return reflect::call(o, arg(1), std::vector<std::string>(a.begin() + 4, a.end()), err);
    }
    if (cmd == "kick") {
        void* pc = need_obj(0);
        if (!pc) return "";
        void* mode = reflect::get_object(game_world(), "AuthorityGameMode");
        void* session = reflect::get_object(mode, "GameSession");
        if (!session) { err = "no game session"; return ""; }
        return reflect::kick_player(session, pc, argc > 1 ? arg(1) : "") ? "true" : "false";
    }
    if (cmd == "xp") {
        void* comp = need_obj(0);
        void* skill = comp ? need_obj(1) : nullptr;
        if (!skill) return "";
        if (argc < 3) { err = "xp <component> <skill> <amount>"; return ""; }
        return reflect::add_skill_xp(comp, skill, strtof(arg(2).c_str(), nullptr)) ? "true" : "false";
    }
    if (cmd == "clearcooldowns") {
        void* comp = need_obj(0);
        if (!comp) return "";
        return std::to_string(reflect::clear_spell_cooldowns(comp));
    }
    if (cmd == "gamestate") return reflect::obj_json(reflect::get_object(game_world(), "GameState"));
    if (cmd == "worldsetting") {
        void* data = need_obj(0);
        if (!data) return "";
        void* gs = reflect::get_object(game_world(), "GameState");
        if (!gs) { err = "no game state"; return ""; }
        if (argc > 1 && !reflect::set_world_setting(gs, data, strtof(arg(1).c_str(), nullptr), err)) return "";
        void* lib = reflect::default_object("DifficultyFunctionLibrary");
        if (!lib) { err = "no difficulty library"; return ""; }
        return reflect::call(lib, "GetSettingValueAsFloatByData", {reflect::ptr_str(gs), reflect::ptr_str(data)}, err);
    }
    err = "unknown command " + cmd;
    return "";
}

std::vector<std::string> split_tabs(const std::string& line) {
    std::vector<std::string> out;
    size_t start = 0;
    for (;;) {
        size_t tab = line.find('\t', start);
        out.push_back(line.substr(start, tab == std::string::npos ? tab : tab - start));
        if (tab == std::string::npos) return out;
        start = tab + 1;
    }
}

void handle_line(Client& c, const std::string& line) {
    std::vector<std::string> a = split_tabs(line);
    if (a.size() < 2) return;
    std::string err;
    std::string res = run_command(a, err);
    std::string id = reflect::json_str(a[0]);
    if (err.empty()) c.out += "{\"id\":" + id + ",\"ok\":true,\"result\":" + (res.empty() ? "null" : res) + "}\n";
    else c.out += "{\"id\":" + id + ",\"ok\":false,\"error\":" + reflect::json_str(err) + "}\n";
}

void open_socket() {
    std::string path = g_dir + "/kit.sock";
    unlink(path.c_str());
    g_listen = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    sockaddr_un addr{};
    addr.sun_family = AF_UNIX;
    snprintf(addr.sun_path, sizeof addr.sun_path, "%s", path.c_str());
    if (g_listen < 0 || bind(g_listen, reinterpret_cast<sockaddr*>(&addr), sizeof addr) != 0 || listen(g_listen, 8) != 0) {
        logf("cannot listen on %s: %s", path.c_str(), strerror(errno));
        if (g_listen >= 0) close(g_listen);
        g_listen = -1;
        return;
    }
    chmod(path.c_str(), 0660);
    logf("listening on %s", path.c_str());
}

// Non-blocking: nothing here may ever stall the game thread.
void poll_socket() {
    if (g_listen < 0) return;
    for (;;) {
        int fd = accept4(g_listen, nullptr, nullptr, SOCK_NONBLOCK | SOCK_CLOEXEC);
        if (fd < 0) break;
        g_clients.push_back({fd, {}, {}});
    }
    int budget = kMaxCommandsPerFrame;
    for (size_t i = 0; i < g_clients.size();) {
        Client& c = g_clients[i];
        bool closed = false;
        char buf[8192];
        for (;;) {
            ssize_t n = recv(c.fd, buf, sizeof buf, 0);
            if (n > 0) {
                c.in.append(buf, n);
                continue;
            }
            if (n == 0 || (errno != EAGAIN && errno != EWOULDBLOCK)) closed = true;
            break;
        }
        size_t nl;
        while (budget > 0 && (nl = c.in.find('\n')) != std::string::npos) {
            std::string line = c.in.substr(0, nl);
            c.in.erase(0, nl + 1);
            if (!line.empty() && line.back() == '\r') line.pop_back();
            handle_line(c, line);
            --budget;
        }
        if (c.in.size() > kMaxLine) closed = true;
        while (!c.out.empty()) {
            ssize_t n = send(c.fd, c.out.data(), c.out.size(), MSG_DONTWAIT | MSG_NOSIGNAL);
            if (n > 0) {
                c.out.erase(0, n);
                continue;
            }
            if (errno != EAGAIN && errno != EWOULDBLOCK) closed = true;
            break;
        }
        if (closed) {
            close(c.fd);
            g_clients.erase(g_clients.begin() + static_cast<long>(i));
        } else {
            ++i;
        }
    }
}

void tick_hook(void* engine, float dt, bool idle) {
    g_orig_tick(engine, dt, idle);
    g_engine = engine;
    if (dt > 0) g_fps = g_fps * 0.95f + (1.0f / dt) * 0.05f;
    static bool first = true;
    if (first) {
        first = false;
        logf("first tick: engine=%s objects=%d", reflect::class_name(engine).c_str(), ue::object_count());
        open_socket();
    }
    poll_socket();
}

bool build_matches() {
    auto* eh = reinterpret_cast<const Elf64_Ehdr*>(ue::kRoStart);
    if (memcmp(eh->e_ident, ELFMAG, SELFMAG) != 0) return false;
    auto* ph = reinterpret_cast<const Elf64_Phdr*>(ue::kRoStart + eh->e_phoff);
    for (int i = 0; i < eh->e_phnum; ++i) {
        if (ph[i].p_type != PT_NOTE) continue;
        const char* p = reinterpret_cast<const char*>(ph[i].p_vaddr);
        const char* end = p + ph[i].p_memsz;
        while (p + sizeof(Elf64_Nhdr) <= end) {
            auto* nh = reinterpret_cast<const Elf64_Nhdr*>(p);
            const char* desc = p + sizeof(*nh) + ((nh->n_namesz + 3) & ~3u);
            if (nh->n_type == NT_GNU_BUILD_ID) {
                char hex[65] = {};
                for (unsigned j = 0; j < nh->n_descsz && j < 32; ++j) snprintf(hex + j * 2, 3, "%02x", (unsigned char)desc[j]);
                logf("server build id %s", hex);
                return strcmp(hex, ue::kBuildId) == 0;
            }
            p = desc + ((nh->n_descsz + 3) & ~3u);
        }
    }
    return false;
}

// Every vtable that inherits the engine Tick holds the same pointer, so all slots are patched.
int install_tick_hook() {
    int patched = 0;
    long page = sysconf(_SC_PAGESIZE);
    for (uintptr_t a = (ue::kRoStart + 7) & ~uintptr_t(7); a + 8 <= ue::kRoEnd; a += 8) {
        if (*reinterpret_cast<uintptr_t*>(a) != ue::kAddrEngineTick) continue;
        void* pg = reinterpret_cast<void*>(a & ~uintptr_t(page - 1));
        if (mprotect(pg, page, PROT_READ | PROT_WRITE) != 0) continue;
        *reinterpret_cast<uintptr_t*>(a) = reinterpret_cast<uintptr_t>(&tick_hook);
        mprotect(pg, page, PROT_READ);
        ++patched;
    }
    return patched;
}

__attribute__((constructor)) void kit_init() {
    char exe[512] = {};
    ssize_t len = readlink("/proc/self/exe", exe, sizeof exe - 1);
    if (len <= 0 || !strstr(exe, "RSDragonwildsServer-Linux-Shipping")) return;  // shell wrappers
    unsetenv("LD_PRELOAD");

    const char* dir = getenv("DWKIT_DIR");
    g_dir = dir ? dir : "/opt/dragonwilds-kit";
    g_log = fopen((g_dir + "/kit.log").c_str(), "w");
    logf("loaded into %s", exe);
    if (!build_matches()) {
        logf("unexpected server build, expected %s: kit disabled", ue::kBuildId);
        return;
    }
    g_orig_tick = reinterpret_cast<TickFn>(ue::kAddrEngineTick);
    logf("tick hook installed in %d slot(s)", install_tick_hook());
}

}  // namespace

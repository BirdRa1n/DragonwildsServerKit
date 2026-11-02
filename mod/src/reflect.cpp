#include "reflect.h"

#include <sys/uio.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <unordered_map>

#include "ue.h"

namespace reflect {
namespace {

using FreeFn = void (*)(void*);
using MallocFn = void* (*)(unsigned long, unsigned int);
using NameToStringFn = void (*)(const ue::FName*, ue::FString*);
using NameCtorFn = void (*)(ue::FName*, const char16_t*, int);
using FindPropFn = void* (*)(void*, ue::FName);
using FindFuncFn = void* (*)(void*, ue::FName);
using ProcessEventFn = void (*)(void*, void*, void*);
using TextToStringFn = const ue::FString* (*)(const void*);
using TextFromStrFn = void (*)(void*, const char16_t*);
using NetIdToStringFn = void (*)(ue::FString*, const void*);
using KickFn = bool (*)(void*, void*, const void*);
using AddXpFn = void (*)(void*, const void*, float, const ue::FString*);
using LoadObjFn = void* (*)(void*, void*, const char16_t*, const char16_t*, unsigned int, void*, bool, void*);

constexpr int kFNameAdd = 1;
constexpr uint64_t kCpfParm = 0x80, kCpfOut = 0x100, kCpfRet = 0x400;
constexpr uint32_t kRfClassDefault = 0x10, kRfArchetype = 0x20;
constexpr int kMaxDepth = 6, kMaxArray = 512;
constexpr int kSpellRescanSeconds = 60;
constexpr float kCooldownLongOver = 1000000.0f;

template <typename F>
F fn(uintptr_t addr) {
    return reinterpret_cast<F>(addr);
}

void mem_free(void* p) { fn<FreeFn>(ue::kAddrFMemoryFree)(p); }

// FFields live on the heap, far above any flag value that shares a slot with them.
bool heap_ptr(void* p) {
    auto v = reinterpret_cast<uintptr_t>(p);
    return v >= 0x100000000000 && v < 0x800000000000 && (v & 7) == 0;
}

std::string fname_str(const ue::FName& n) {
    ue::FString s;
    fn<NameToStringFn>(ue::kAddrFNameToString)(&n, &s);
    std::string out = to_utf8(s.data, s.num > 0 ? s.num - 1 : 0);
    if (s.data) mem_free(s.data);
    return out;
}

ue::FName make_name(const char* text) {
    std::u16string w = to_utf16(text);
    ue::FName n;
    fn<NameCtorFn>(ue::kAddrFNameCtor)(&n, w.c_str(), kFNameAdd);
    return n;
}

ue::FString make_fstring(const std::string& text) {
    std::u16string w = to_utf16(text);
    ue::FString s;
    if (w.empty()) return s;
    s.num = s.max = static_cast<int32_t>(w.size()) + 1;
    s.data = static_cast<char16_t*>(fn<MallocFn>(ue::kAddrFMemoryMalloc)(s.num * sizeof(char16_t), 0));
    memcpy(s.data, w.c_str(), s.num * sizeof(char16_t));
    return s;
}

std::string prop_class(void* p) { return fname_str(*static_cast<ue::FName*>(ue::at<void*>(p, ue::kFFieldClass))); }
std::string prop_name(void* p) { return fname_str(ue::at<ue::FName>(p, ue::kFFieldName)); }

void* array_inner(void* p) {
    // FArrayProperty keeps its flags before Inner on this build.
    for (int off = ue::kPropExtra; off <= ue::kPropExtra + 16; off += 8) {
        void* inner = ue::at<void*>(p, off);
        if (heap_ptr(inner)) return inner;
    }
    return nullptr;
}

bool bool_value(void* prop, void* value) {
    auto* b = reinterpret_cast<uint8_t*>(static_cast<char*>(prop) + ue::kPropExtra);
    return (static_cast<uint8_t*>(value)[b[1]] & b[3]) != 0;
}

void write_bool(void* prop, void* value, bool on) {
    auto* b = reinterpret_cast<uint8_t*>(static_cast<char*>(prop) + ue::kPropExtra);
    auto* byte = static_cast<uint8_t*>(value) + b[1];
    *byte = on ? (*byte | b[2]) : (*byte & ~b[2]);
}

std::string number(double v) {
    char buf[64];
    snprintf(buf, sizeof buf, "%.10g", v);
    return buf;
}

// `value` points at the property's storage, already offset inside its container.
std::string value_json(void* prop, void* value, int depth);

std::string struct_json(void* strukt, void* data, int depth) {
    std::string out = "{";
    bool first = true;
    // Includes inherited fields: FVector_NetQuantize, for one, has all of its members in FVector.
    for (void* s = strukt; s; s = ue::at<void*>(s, ue::kStructSuper)) {
        for (void* p = ue::at<void*>(s, ue::kStructChildProps); heap_ptr(p); p = ue::at<void*>(p, ue::kFFieldNext)) {
            if (!first) out += ",";
            first = false;
            out += json_str(prop_name(p)) + ":" + value_json(p, static_cast<char*>(data) + ue::at<int32_t>(p, ue::kPropOffset), depth + 1);
        }
    }
    return out + "}";
}

std::string soft_path(void* value) {
    // FSoftObjectPtr: weak pointer, then package FName, asset FName, subpath FString.
    std::string pkg = fname_str(ue::at<ue::FName>(value, 8));
    std::string asset = fname_str(ue::at<ue::FName>(value, 16));
    return pkg + "." + asset;
}

std::string value_json(void* prop, void* value, int depth) {
    if (depth > kMaxDepth) return "null";
    std::string t = prop_class(prop);
    if (t == "BoolProperty") return bool_value(prop, value) ? "true" : "false";
    if (t == "ByteProperty" || t == "Int8Property") return number(*static_cast<uint8_t*>(value));
    if (t == "Int16Property" || t == "UInt16Property") return number(*static_cast<int16_t*>(value));
    if (t == "IntProperty") return number(*static_cast<int32_t*>(value));
    if (t == "UInt32Property") return number(*static_cast<uint32_t*>(value));
    if (t == "Int64Property") return number(static_cast<double>(*static_cast<int64_t*>(value)));
    if (t == "UInt64Property") return number(static_cast<double>(*static_cast<uint64_t*>(value)));
    if (t == "FloatProperty") return number(*static_cast<float*>(value));
    if (t == "DoubleProperty") return number(*static_cast<double*>(value));
    if (t == "StrProperty") {
        auto* s = static_cast<ue::FString*>(value);
        return json_str(to_utf8(s->data, s->num > 0 ? s->num - 1 : 0));
    }
    if (t == "NameProperty") return json_str(fname_str(*static_cast<ue::FName*>(value)));
    if (t == "TextProperty") {
        const ue::FString* s = fn<TextToStringFn>(ue::kAddrFTextToString)(value);
        return json_str(s && s->data ? to_utf8(s->data, s->num > 0 ? s->num - 1 : 0) : "");
    }
    if (t == "EnumProperty") {
        int size = ue::at<int32_t>(prop, ue::kPropSize);
        return number(size == 1 ? *static_cast<uint8_t*>(value) : *static_cast<int32_t*>(value));
    }
    if (t == "ObjectProperty" || t == "ClassProperty" || t == "ObjectPtrProperty") return obj_json(*static_cast<void**>(value));
    if (t == "SoftObjectProperty" || t == "SoftClassProperty") return json_str(soft_path(value));
    if (t == "StructProperty") return struct_json(ue::at<void*>(prop, ue::kPropExtra), value, depth);
    if (t == "ArrayProperty") {
        void* inner = array_inner(prop);
        if (!inner) return "null";
        char* data = *static_cast<char**>(value);
        int num = *reinterpret_cast<int32_t*>(static_cast<char*>(value) + 8);
        int stride = ue::at<int32_t>(inner, ue::kPropSize);
        std::string out = "[";
        for (int i = 0; i < num && i < kMaxArray; ++i) {
            if (i) out += ",";
            out += value_json(inner, data + i * stride, depth + 1);
        }
        return out + "]";
    }
    return "null";
}

double parts_of(const std::string& text, double* out, int n) {
    int got = 0;
    const char* p = text.c_str();
    char* end = nullptr;
    while (got < n && *p) {
        out[got++] = strtod(p, &end);
        if (end == p) break;
        p = *end == ',' ? end + 1 : end;
    }
    return got;
}

// Writes `text` into a parameter or property. Strings are allocated with FMemory, as the engine expects.
bool write_value(void* prop, void* value, const std::string& text, std::string& err) {
    std::string t = prop_class(prop);
    if (t == "BoolProperty") {
        write_bool(prop, value, text == "1" || text == "true");
    } else if (t == "ByteProperty" || t == "Int8Property") {
        *static_cast<uint8_t*>(value) = static_cast<uint8_t>(atoi(text.c_str()));
    } else if (t == "EnumProperty") {
        if (ue::at<int32_t>(prop, ue::kPropSize) == 1) *static_cast<uint8_t*>(value) = static_cast<uint8_t>(atoi(text.c_str()));
        else *static_cast<int32_t*>(value) = atoi(text.c_str());
    } else if (t == "IntProperty" || t == "UInt32Property") {
        *static_cast<int32_t*>(value) = atoi(text.c_str());
    } else if (t == "Int64Property" || t == "UInt64Property") {
        *static_cast<int64_t*>(value) = atoll(text.c_str());
    } else if (t == "FloatProperty") {
        *static_cast<float*>(value) = strtof(text.c_str(), nullptr);
    } else if (t == "DoubleProperty") {
        *static_cast<double*>(value) = strtod(text.c_str(), nullptr);
    } else if (t == "StrProperty") {
        *static_cast<ue::FString*>(value) = make_fstring(text);
    } else if (t == "NameProperty") {
        *static_cast<ue::FName*>(value) = make_name(text.c_str());
    } else if (t == "ObjectProperty" || t == "ClassProperty" || t == "ObjectPtrProperty") {
        void* o = text == "0" ? nullptr : parse_obj(text);
        if (!o && text != "0") {
            err = "invalid object " + text;
            return false;
        }
        *static_cast<void**>(value) = o;
    } else if (t == "SoftObjectProperty" || t == "SoftClassProperty") {
        size_t dot = text.rfind('.');
        if (dot == std::string::npos) {
            err = "soft path needs package.asset";
            return false;
        }
        ue::at<ue::FName>(value, 8) = make_name(text.substr(0, dot).c_str());
        ue::at<ue::FName>(value, 16) = make_name(text.substr(dot + 1).c_str());
    } else if (t == "StructProperty") {
        std::string st = obj_name(ue::at<void*>(prop, ue::kPropExtra));
        double v[4] = {};
        if (st == "Vector" || st == "Rotator") {
            if (parts_of(text, v, 3) != 3) {
                err = st + " needs a,b,c";
                return false;
            }
            memcpy(value, v, 3 * sizeof(double));
        } else {
            // Named fields: key=value;key=value
            void* strukt = ue::at<void*>(prop, ue::kPropExtra);
            size_t pos = 0;
            while (pos < text.size()) {
                size_t semi = text.find(';', pos);
                if (semi == std::string::npos) semi = text.size();
                std::string pair = text.substr(pos, semi - pos);
                pos = semi + 1;
                size_t eq = pair.find('=');
                if (eq == std::string::npos) {
                    err = st + " needs key=value";
                    return false;
                }
                std::string key = pair.substr(0, eq);
                void* field = nullptr;
                for (void* f = ue::at<void*>(strukt, ue::kStructChildProps); heap_ptr(f); f = ue::at<void*>(f, ue::kFFieldNext)) {
                    if (prop_name(f) == key) {
                        field = f;
                        break;
                    }
                }
                if (!field) {
                    err = st + " has no field " + key;
                    return false;
                }
                if (!write_value(field, static_cast<char*>(value) + ue::at<int32_t>(field, ue::kPropOffset), pair.substr(eq + 1), err)) return false;
            }
        }
    } else {
        err = "unsupported type " + t;
        return false;
    }
    return true;
}

}  // namespace

std::string to_utf8(const char16_t* s, int len) {
    std::string out;
    if (!s) return out;
    for (int i = 0; len < 0 ? s[i] != 0 : i < len; ++i) {
        uint32_t c = s[i];
        if (c >= 0xd800 && c < 0xdc00 && (len < 0 || i + 1 < len) && s[i + 1] >= 0xdc00 && s[i + 1] < 0xe000) {
            c = 0x10000 + ((c - 0xd800) << 10) + (s[++i] - 0xdc00);
        }
        if (c < 0x80) {
            out += static_cast<char>(c);
        } else if (c < 0x800) {
            out += static_cast<char>(0xc0 | (c >> 6));
            out += static_cast<char>(0x80 | (c & 0x3f));
        } else if (c < 0x10000) {
            out += static_cast<char>(0xe0 | (c >> 12));
            out += static_cast<char>(0x80 | ((c >> 6) & 0x3f));
            out += static_cast<char>(0x80 | (c & 0x3f));
        } else {
            out += static_cast<char>(0xf0 | (c >> 18));
            out += static_cast<char>(0x80 | ((c >> 12) & 0x3f));
            out += static_cast<char>(0x80 | ((c >> 6) & 0x3f));
            out += static_cast<char>(0x80 | (c & 0x3f));
        }
    }
    return out;
}

std::u16string to_utf16(const std::string& s) {
    std::u16string out;
    for (size_t i = 0; i < s.size();) {
        unsigned char c = s[i];
        uint32_t cp;
        int n;
        if (c < 0x80) { cp = c; n = 1; }
        else if (c < 0xe0) { cp = c & 0x1f; n = 2; }
        else if (c < 0xf0) { cp = c & 0x0f; n = 3; }
        else { cp = c & 0x07; n = 4; }
        for (int j = 1; j < n && i + j < s.size(); ++j) cp = (cp << 6) | (s[i + j] & 0x3f);
        i += n;
        if (cp >= 0x10000) {
            cp -= 0x10000;
            out += static_cast<char16_t>(0xd800 + (cp >> 10));
            out += static_cast<char16_t>(0xdc00 + (cp & 0x3ff));
        } else {
            out += static_cast<char16_t>(cp);
        }
    }
    return out;
}

std::string obj_name(void* o) { return o ? fname_str(ue::at<ue::FName>(o, ue::kObjName)) : "null"; }
std::string class_name(void* o) { return o ? obj_name(ue::at<void*>(o, ue::kObjClass)) : "null"; }

std::string json_str(const std::string& s) {
    std::string out = "\"";
    for (unsigned char c : s) {
        if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
        else if (c == '\n') out += "\\n";
        else if (c == '\t') out += "\\t";
        else if (c == '\r') out += "\\r";
        else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); out += b; }
        else out += static_cast<char>(c);
    }
    return out + "\"";
}

std::string ptr_str(void* p) {
    char b[32];
    snprintf(b, sizeof b, "0x%llx", (unsigned long long)reinterpret_cast<uintptr_t>(p));
    return b;
}

std::string obj_json(void* o) {
    if (!o) return "null";
    return "{\"ptr\":" + json_str(ptr_str(o)) + ",\"name\":" + json_str(obj_name(o)) + ",\"class\":" + json_str(class_name(o)) + "}";
}

void* parse_obj(const std::string& text) {
    uintptr_t v = strtoull(text.c_str(), nullptr, 16);
    if (!v) return nullptr;
    // A stale pointer must fail here, not crash the server: read it through the kernel first.
    int32_t index = -1;
    iovec local{&index, sizeof index};
    iovec remote{reinterpret_cast<void*>(v + ue::kObjIndex), sizeof index};
    if (process_vm_readv(getpid(), &local, 1, &remote, 1, 0) != sizeof index) return nullptr;
    return ue::object_at(index) == reinterpret_cast<void*>(v) ? reinterpret_cast<void*>(v) : nullptr;
}

void* find_class(const std::string& name) {
    static std::unordered_map<std::string, void*> cache;
    auto it = cache.find(name);
    if (it != cache.end()) return it->second;
    for (int i = 0, n = ue::object_count(); i < n; ++i) {
        void* o = ue::object_at(i);
        if (!o || obj_name(o) != name) continue;
        std::string cn = class_name(o);
        if (cn == "Class" || cn == "BlueprintGeneratedClass") return cache[name] = o;
    }
    return nullptr;
}

bool is_a(void* obj, void* cls) {
    for (void* c = ue::at<void*>(obj, ue::kObjClass); c; c = ue::at<void*>(c, ue::kStructSuper))
        if (c == cls) return true;
    return false;
}

std::vector<void*> find_instances(const std::string& name, int limit) {
    std::vector<void*> out;
    void* cls = find_class(name);
    if (!cls) return out;
    for (int i = 0, n = ue::object_count(); i < n && static_cast<int>(out.size()) < limit; ++i) {
        void* o = ue::object_at(i);
        // Templates and class defaults are not live objects: they have no world, and calling into them crashes.
        if (!o || (ue::at<uint32_t>(o, ue::kObjFlags) & (kRfClassDefault | kRfArchetype)) || !is_a(o, cls)) continue;
        out.push_back(o);
    }
    return out;
}

void* default_object(const std::string& name) { return find_named("Default__" + name, ""); }

void* find_named(const std::string& object_name, const std::string& cls_name) {
    void* cls = cls_name.empty() ? nullptr : find_class(cls_name);
    for (int i = 0, n = ue::object_count(); i < n; ++i) {
        void* o = ue::object_at(i);
        if (!o || obj_name(o) != object_name) continue;
        if (!cls || is_a(o, cls)) return o;
    }
    return nullptr;
}

void* find_property(void* strukt, const char* name) {
    return fn<FindPropFn>(ue::kAddrFindProperty)(strukt, make_name(name));
}

void* find_function(void* obj, const char* name) { return fn<FindFuncFn>(ue::kAddrFindFunction)(obj, make_name(name)); }

std::string prop_json(void* prop, void* container) {
    return value_json(prop, static_cast<char*>(container) + ue::at<int32_t>(prop, ue::kPropOffset), 0);
}

std::string get_json(void* obj, const char* prop_name_) {
    void* p = find_property(ue::at<void*>(obj, ue::kObjClass), prop_name_);
    return p ? prop_json(p, obj) : "null";
}

bool set_value(void* obj, const char* prop_name_, const std::string& value, std::string& err) {
    void* p = find_property(ue::at<void*>(obj, ue::kObjClass), prop_name_);
    if (!p) {
        err = "no property";
        return false;
    }
    return write_value(p, static_cast<char*>(obj) + ue::at<int32_t>(p, ue::kPropOffset), value, err);
}

void* get_object(void* obj, const char* prop_name_) {
    if (!obj) return nullptr;
    void* p = find_property(ue::at<void*>(obj, ue::kObjClass), prop_name_);
    return p ? ue::at<void*>(obj, ue::at<int32_t>(p, ue::kPropOffset)) : nullptr;
}

std::string call(void* obj, const std::string& func, const std::vector<std::string>& args, std::string& err) {
    void* f = find_function(obj, func.c_str());
    if (!f) {
        err = "function not found: " + func;
        return "";
    }
    int size = ue::at<uint16_t>(f, ue::kFuncParmsSize);
    std::vector<char> storage(size + 16, 0);
    char* frame = reinterpret_cast<char*>((reinterpret_cast<uintptr_t>(storage.data()) + 15) & ~uintptr_t(15));

    size_t used = 0;
    std::vector<ue::FString*> allocated;
    for (void* p = ue::at<void*>(f, ue::kStructChildProps); heap_ptr(p); p = ue::at<void*>(p, ue::kFFieldNext)) {
        uint64_t flags = ue::at<uint64_t>(p, ue::kPropFlags);
        if (!(flags & kCpfParm) || (flags & kCpfRet)) continue;
        if (used >= args.size()) break;
        const std::string& arg = args[used++];
        if (arg == "-") continue;
        void* value = frame + ue::at<int32_t>(p, ue::kPropOffset);
        if (!write_value(p, value, arg, err)) {
            err = prop_name(p) + ": " + err;
            return "";
        }
        if (prop_class(p) == "StrProperty") allocated.push_back(static_cast<ue::FString*>(value));
    }

    fn<ProcessEventFn>(ue::kAddrProcessEvent)(obj, f, frame);

    std::string out = "{";
    bool first = true;
    for (void* p = ue::at<void*>(f, ue::kStructChildProps); heap_ptr(p); p = ue::at<void*>(p, ue::kFFieldNext)) {
        uint64_t flags = ue::at<uint64_t>(p, ue::kPropFlags);
        if (!(flags & (kCpfRet | kCpfOut))) continue;
        if (!first) out += ",";
        first = false;
        out += json_str(prop_name(p)) + ":" + prop_json(p, frame);
    }
    for (ue::FString* s : allocated)
        if (s->data) mem_free(s->data);
    return out + "}";
}

std::string net_id_string(void* repl) {
    ue::FString s;
    fn<NetIdToStringFn>(ue::kAddrNetIdToString)(&s, repl);
    std::string out = to_utf8(s.data, s.num > 0 ? s.num - 1 : 0);
    if (s.data) mem_free(s.data);
    return out;
}

std::string text_of_fname(const void* fname) { return fname_str(*static_cast<const ue::FName*>(fname)); }

bool kick_player(void* game_session, void* controller, const std::string& reason) {
    alignas(16) char text[32] = {};
    std::u16string w = to_utf16(reason);
    fn<TextFromStrFn>(ue::kAddrFTextFromStr)(text, w.c_str());
    return fn<KickFn>(ue::kAddrKickPlayer)(game_session, controller, text);
}

bool add_skill_xp(void* skill_component, void* skill_data, float xp) {
    struct {
        void* skill;
        float xp;
        int pad;
    } ev{skill_data, xp, 0};
    ue::FString ctx = make_fstring("DWKit");
    fn<AddXpFn>(ue::kAddrAddEventSkillXp)(skill_component, &ev, 1.0f, &ctx);
    if (ctx.data) mem_free(ctx.data);
    return true;
}

int clear_spell_cooldowns(void* magic_component) {
    // Spell assets stay loaded, and scanning every object twice a second per player would be wasteful.
    static std::vector<void*> spells;
    static time_t scanned = 0;
    time_t now = time(nullptr);
    if (spells.empty() || now - scanned > kSpellRescanSeconds) {
        spells = find_instances("UtilitySpellData", 512);
        scanned = now;
    }
    // StartCooldown stores "now - elapsed" and sends the same value to the owning client. Doing this
    // only once a cooldown has begun means it arrives after the game's own "just cast" notification.
    int cleared = 0;
    for (void* spell : spells) {
        if (!fn<bool (*)(void*, void*)>(ue::kAddrIsSpellCoolingDown)(magic_component, spell)) continue;
        fn<void (*)(void*, void*, float)>(ue::kAddrStartCooldown)(magic_component, spell, kCooldownLongOver);
        ++cleared;
    }
    return cleared;
}

bool set_world_setting(void* game_state, void* setting_data, float value, std::string& err) {
    void* comp = get_object(game_state, "SurvivalDifficultyComponent");
    std::vector<void*> persistence = find_instances("PersistenceSubsystem", 1);
    void* tag_prop = find_property(ue::at<void*>(setting_data, ue::kObjClass), "SettingTag");
    if (!comp || persistence.empty() || !tag_prop) {
        err = "world settings unavailable";
        return false;
    }
    void* settings_prop = find_property(ue::at<void*>(persistence[0], ue::kObjClass), "WorldSaveSettings");
    if (!settings_prop) {
        err = "world save settings unavailable";
        return false;
    }
    char* map = static_cast<char*>(persistence[0]) + ue::at<int32_t>(settings_prop, ue::kPropOffset) + ue::kWorldSettingsCustom;
    struct {
        const void* key;
        const float* value;
    } pair{static_cast<char*>(setting_data) + ue::at<int32_t>(tag_prop, ue::kPropOffset), &value};
    bool existed = false;
    fn<int32_t (*)(void*, void*, bool*)>(ue::kAddrTagFloatMapEmplace)(map, &pair, &existed);
    fn<void (*)(void*)>(ue::kAddrUpdateCustomSettings)(comp);
    fn<void (*)(void*)>(ue::kAddrUpdateDifficultySubsystem)(comp);
    return true;
}

void* load_object(const std::string& path) {
    std::u16string w = to_utf16(path);
    return fn<LoadObjFn>(ue::kAddrStaticLoadObject)(nullptr, nullptr, w.c_str(), nullptr, 0, nullptr, true, nullptr);
}

}  // namespace reflect

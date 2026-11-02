// Optional override of the address a session advertises, for a server reachable only over a private
// network such as Tailscale. EOS otherwise advertises the public IP, which needs a router port forward.
// Set DWKIT_HOST_ADDRESS=ip:port to use it. Without it, these calls pass through untouched.
#include <dlfcn.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>

namespace {

struct SetHostAddressOptions {
    int32_t api_version;
    const char* host_address;
};

using SetHostFn = int32_t (*)(void*, const SetHostAddressOptions*);
using ModifyFn = int32_t (*)(void*, const void*, void**);

constexpr int32_t kEosSuccess = 0;
constexpr int32_t kSetHostApiLatest = 1;

template <typename F>
F real(const char* name) {
    return reinterpret_cast<F>(dlvsym(RTLD_NEXT, name, "EOSSDK"));
}

const char* override_address() {
    static const char* value = getenv("DWKIT_HOST_ADDRESS");
    return value;
}

int32_t apply_override(void* modification) {
    static SetHostFn set_host = real<SetHostFn>("EOS_SessionModification_SetHostAddress");
    const SetHostAddressOptions opts{kSetHostApiLatest, override_address()};
    int32_t r = set_host ? set_host(modification, &opts) : -1;
    fprintf(stderr, "[DWKit] session host address -> %s (result %d)\n", opts.host_address, r);
    return r;
}

}  // namespace

extern "C" {

__attribute__((visibility("default"))) int32_t EOS_SessionModification_SetHostAddress(void* modification, const SetHostAddressOptions* options) {
    if (override_address()) return apply_override(modification);
    static SetHostFn set_host = real<SetHostFn>("EOS_SessionModification_SetHostAddress");
    return set_host(modification, options);
}

__attribute__((visibility("default"))) int32_t EOS_Sessions_CreateSessionModification(void* sessions, const void* options, void** out) {
    static ModifyFn create = real<ModifyFn>("EOS_Sessions_CreateSessionModification");
    int32_t r = create(sessions, options, out);
    if (r == kEosSuccess && override_address()) apply_override(*out);
    return r;
}

__attribute__((visibility("default"))) int32_t EOS_Sessions_UpdateSessionModification(void* sessions, const void* options, void** out) {
    static ModifyFn update = real<ModifyFn>("EOS_Sessions_UpdateSessionModification");
    int32_t r = update(sessions, options, out);
    if (r == kEosSuccess && override_address()) apply_override(*out);
    return r;
}

}  // extern "C"

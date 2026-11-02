// Layout and addresses for RSDragonwildsServer-Linux-Shipping, build c695030ea461f775
// (Dragonwilds 1.0.0.5, UE 5.6.1 CL-244954). The executable is not PIE, so addresses are absolute.
// Offsets were read from the binary's own disassembly; do not reuse them on another build.
#pragma once
#include <cstdint>

namespace ue {

inline constexpr const char* kBuildId = "c695030ea461f775";

inline constexpr uintptr_t kRoStart = 0x200000;
inline constexpr uintptr_t kRoEnd = 0x200000 + 0x49a2118;

inline constexpr uintptr_t kAddrGUObjectArray = 0xde36500;
inline constexpr uintptr_t kAddrEngineTick = 0x9d30db0;  // UJgxGameEngine::Tick, the engine class this game instantiates
inline constexpr uintptr_t kAddrGetGameWorld = 0x80f8d10;
inline constexpr uintptr_t kAddrFMemoryFree = 0x4c5f480;
inline constexpr uintptr_t kAddrFMemoryMalloc = 0x4c5f420;
inline constexpr uintptr_t kAddrFNameToString = 0x4e08050;
inline constexpr uintptr_t kAddrFNameCtor = 0x4e062b0;  // FName(char16_t const*, EFindName)
inline constexpr uintptr_t kAddrFindProperty = 0x4fc40f0;
inline constexpr uintptr_t kAddrFindFunction = 0x503f190;
inline constexpr uintptr_t kAddrProcessEvent = 0x503f250;
inline constexpr uintptr_t kAddrFTextFromStr = 0x4ca5b20;  // FText::FromString(char16_t const*)
inline constexpr uintptr_t kAddrFTextToString = 0x4ca0a80;  // FTextInspector::GetDisplayString
inline constexpr uintptr_t kAddrNetIdToString = 0x6babee0;  // FUniqueNetIdWrapper::ToString
inline constexpr uintptr_t kAddrKickPlayer = 0xa566100;  // ADominionGameSession::KickPlayer(APlayerController*, FText const&)
inline constexpr uintptr_t kAddrAddEventSkillXp = 0xa8c7480;
inline constexpr uintptr_t kAddrStaticLoadObject = 0x507ad60;
inline constexpr uintptr_t kAddrIsSpellCoolingDown = 0xa6bc100;  // UPlayerUtilityMagicComponent::IsSpellDataCoolingDown
inline constexpr uintptr_t kAddrStartCooldown = 0xa6bdb80;  // UPlayerUtilityMagicComponent::StartCooldown
inline constexpr uintptr_t kAddrTagFloatMapEmplace = 0xa826860;  // TSet<TTuple<FGameplayTag, float>>::Emplace
inline constexpr uintptr_t kAddrUpdateCustomSettings = 0xa5435a0;  // USurvivalDifficultyComponent::UpdateCustomSettingsFromWorldSettings
inline constexpr uintptr_t kAddrUpdateDifficultySubsystem = 0xa543b30;  // USurvivalDifficultyComponent::UpdateDifficultySubsystem

struct FString {
    char16_t* data = nullptr;
    int32_t num = 0;
    int32_t max = 0;
};

struct FName {
    uint32_t index = 0;
    uint32_t number = 0;
};

// UObject
inline constexpr int kObjFlags = 0x08;
inline constexpr int kObjIndex = 0x0c;
inline constexpr int kObjClass = 0x10;
inline constexpr int kObjName = 0x18;
inline constexpr int kObjOuter = 0x20;
// FDomGameWorldSettings
inline constexpr int kWorldSettingsCustom = 0x50;  // TMap<FGameplayTag, float> CustomDifficultySettings
// UField
inline constexpr int kFieldNext = 0x28;
// UStruct
inline constexpr int kStructSuper = 0x40;
inline constexpr int kStructChildren = 0x48;
inline constexpr int kStructChildProps = 0x50;
inline constexpr int kStructSize = 0x58;
// UFunction
inline constexpr int kFuncFlags = 0xb0;
inline constexpr int kFuncParmsSize = 0xb6;
// FField / FProperty (5.6 layout on this build: compact owner, no FField padding)
inline constexpr int kFFieldClass = 0x08;
inline constexpr int kFFieldNext = 0x18;
inline constexpr int kFFieldName = 0x20;
inline constexpr int kPropSize = 0x30;
inline constexpr int kPropFlags = 0x38;
inline constexpr int kPropOffset = 0x44;
inline constexpr int kPropExtra = 0x70;  // PropertyClass, Struct, Inner, Enum, or bool masks
// FUObjectArray
inline constexpr int kArrObjects = 0x10;
inline constexpr int kArrNum = 0x24;
inline constexpr int kItemStride = 24;
inline constexpr int kChunkSize = 64 * 1024;

template <typename T>
inline T& at(void* base, int off) {
    return *reinterpret_cast<T*>(static_cast<char*>(base) + off);
}

inline void* object_at(int i) {
    void* arr = reinterpret_cast<void*>(kAddrGUObjectArray);
    if (i < 0 || i >= at<int32_t>(arr, kArrNum)) return nullptr;
    char** chunks = at<char**>(arr, kArrObjects);
    if (!chunks || !chunks[i / kChunkSize]) return nullptr;
    return *reinterpret_cast<void**>(chunks[i / kChunkSize] + (i % kChunkSize) * kItemStride);
}

inline int object_count() {
    return at<int32_t>(reinterpret_cast<void*>(kAddrGUObjectArray), kArrNum);
}

}  // namespace ue

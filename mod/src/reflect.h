// Generic access to the game's reflection data: find objects, read and write properties, call
// functions. Values cross the RPC boundary as JSON (out) and short text arguments (in).
#pragma once
#include <string>
#include <vector>

namespace reflect {

std::string to_utf8(const char16_t* s, int len = -1);
std::u16string to_utf16(const std::string& s);

std::string obj_name(void* o);
std::string class_name(void* o);
std::string json_str(const std::string& s);
std::string obj_json(void* o);
std::string ptr_str(void* p);

// Parses "0x..." and returns the object only if it is a live entry of GUObjectArray.
void* parse_obj(const std::string& text);

void* find_class(const std::string& name);
bool is_a(void* obj, void* cls);
std::vector<void*> find_instances(const std::string& class_name_, int limit);
void* default_object(const std::string& class_name_);
void* find_named(const std::string& object_name, const std::string& class_name_);

void* find_property(void* strukt, const char* name);
void* find_function(void* obj, const char* name);

// JSON for the value of property `prop` inside `container`.
std::string prop_json(void* prop, void* container);
std::string get_json(void* obj, const char* prop_name);
bool set_value(void* obj, const char* prop_name, const std::string& value, std::string& err);

// Direct typed reads for the snapshot. They return false if the property does not exist.
void* get_object(void* obj, const char* prop_name);

// Calls a UFunction with one text argument per non-return parameter ("-" leaves it zeroed).
// Returns a JSON object with the return value and out parameters, or sets err.
std::string call(void* obj, const std::string& func, const std::vector<std::string>& args, std::string& err);

std::string net_id_string(void* repl);
std::string text_of_fname(const void* fname);

bool kick_player(void* game_session, void* controller, const std::string& reason);
bool add_skill_xp(void* skill_component, void* skill_data, float xp);
void* load_object(const std::string& path);
// Ends every running utility spell cooldown of one player, on the server and on their client.
int clear_spell_cooldowns(void* magic_component);
// Changes a world difficulty setting through the game's own flow: saved with the world and replicated.
bool set_world_setting(void* game_state, void* setting_data, float value, std::string& err);

}  // namespace reflect

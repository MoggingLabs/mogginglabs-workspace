; Tag query for the brain (ADR 0018) — clean-room, the tags.scm SHAPE: capture
; names bucket by prefix (definition.* / reference.* / import*), and extract.ts
; maps the dotted suffix to a node kind. Kept small on purpose.
(function_declaration name: (identifier) @definition.function)
; Ambient/declared functions — the shape .d.ts files use (ADR 0018/08: the
; library lens distills bundled type signatures through this same query).
(function_signature name: (identifier) @definition.function)
(class_declaration name: (type_identifier) @definition.class)
(interface_declaration name: (type_identifier) @definition.interface)
(type_alias_declaration name: (type_identifier) @definition.type)
(enum_declaration name: (identifier) @definition.enum)
(method_definition name: (property_identifier) @definition.method)
(call_expression function: (identifier) @reference.call)
(call_expression function: (member_expression property: (property_identifier) @reference.call))
(extends_clause (identifier) @reference.extends)
(implements_clause (type_identifier) @reference.implements)
(import_statement) @import

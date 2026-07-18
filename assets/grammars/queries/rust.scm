; Tag query for the brain (ADR 0018) — clean-room, the tags.scm SHAPE.
(function_item name: (identifier) @definition.function)
(struct_item name: (type_identifier) @definition.type)
(enum_item name: (type_identifier) @definition.type)
(trait_item name: (type_identifier) @definition.type)
(call_expression function: (identifier) @reference.call)
(call_expression function: (field_expression field: (field_identifier) @reference.call))
(use_declaration) @import

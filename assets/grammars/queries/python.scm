; Tag query for the brain (ADR 0018) — clean-room, the tags.scm SHAPE.
(function_definition name: (identifier) @definition.function)
(class_definition name: (identifier) @definition.class)
(class_definition superclasses: (argument_list (identifier) @reference.extends))
(call function: (identifier) @reference.call)
(call function: (attribute attribute: (identifier) @reference.call))
(import_statement) @import
(import_from_statement) @import

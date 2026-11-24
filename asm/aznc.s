// aznc.s — generated AZ_COUNT N-API call counters.
// In an AZ_COUNT build, AZ_NAPI(n) expands to _aznc_<n>: a thunk that
// increments _aznct_<n> then tail-calls the real symbol.
// _az_napicalls() -> x0 = &counter[0], x1 = &names_table (idx*40 bytes)
#include "port.h"
#ifdef __APPLE__
#define SYM(n) _##n
#define CTR(n) _aznct_##n
#define THK(n) _aznc_##n
#else
#define SYM(n) n
#define CTR(n) aznct_##n
#define THK(n) aznc_##n
#endif

.macro AZNC name
    .text
    .globl THK(\name)
THK(\name):
    AZ_ADR x16, CTR(\name)
    ldr x17, [x16]
    add x17, x17, #1
    str x17, [x16]
    b SYM(\name)
    .section __DATA,__data
    .globl CTR(\name)
    .p2align 3
CTR(\name): .quad 0
.endm
    AZNC napi_call_function
    AZNC napi_coerce_to_bool
    AZNC napi_coerce_to_number
    AZNC napi_coerce_to_string
    AZNC napi_create_array
    AZNC napi_create_array_with_length
    AZNC napi_create_arraybuffer
    AZNC napi_create_bigint_int64
    AZNC napi_create_double
    AZNC napi_create_function
    AZNC napi_create_object
    AZNC napi_create_reference
    AZNC napi_create_string_utf8
    AZNC napi_define_properties
    AZNC napi_delete_reference
    AZNC napi_get_and_clear_last_exception
    AZNC napi_get_array_length
    AZNC napi_get_boolean
    AZNC napi_get_cb_info
    AZNC napi_get_element
    AZNC napi_get_global
    AZNC napi_get_named_property
    AZNC napi_get_null
    AZNC napi_get_property
    AZNC napi_get_property_names
    AZNC napi_get_prototype
    AZNC napi_get_reference_value
    AZNC napi_get_typedarray_info
    AZNC napi_get_undefined
    AZNC napi_get_value_bigint_int64
    AZNC napi_get_value_bool
    AZNC napi_get_value_double
    AZNC napi_get_value_string_utf16
    AZNC napi_get_value_string_utf8
    AZNC napi_get_value_uint32
    AZNC napi_instanceof
    AZNC napi_is_array
    AZNC napi_is_date
    AZNC napi_is_exception_pending
    AZNC napi_set_element
    AZNC napi_set_named_property
    AZNC napi_set_property
    AZNC napi_strict_equals
    AZNC napi_typeof

// table: names in fixed 32B slots, same order as AZNC list
    AZ_RODATA
    .globl SYM(aznct_names)
    .p2align 4
SYM(aznct_names):
    .ascii "napi_call_function"
    .zero 22
    .ascii "napi_coerce_to_bool"
    .zero 21
    .ascii "napi_coerce_to_number"
    .zero 19
    .ascii "napi_coerce_to_string"
    .zero 19
    .ascii "napi_create_array"
    .zero 23
    .ascii "napi_create_array_with_length"
    .zero 11
    .ascii "napi_create_arraybuffer"
    .zero 17
    .ascii "napi_create_bigint_int64"
    .zero 16
    .ascii "napi_create_double"
    .zero 22
    .ascii "napi_create_function"
    .zero 20
    .ascii "napi_create_object"
    .zero 22
    .ascii "napi_create_reference"
    .zero 19
    .ascii "napi_create_string_utf8"
    .zero 17
    .ascii "napi_define_properties"
    .zero 18
    .ascii "napi_delete_reference"
    .zero 19
    .ascii "napi_get_and_clear_last_exception"
    .zero 7
    .ascii "napi_get_array_length"
    .zero 19
    .ascii "napi_get_boolean"
    .zero 24
    .ascii "napi_get_cb_info"
    .zero 24
    .ascii "napi_get_element"
    .zero 24
    .ascii "napi_get_global"
    .zero 25
    .ascii "napi_get_named_property"
    .zero 17
    .ascii "napi_get_null"
    .zero 27
    .ascii "napi_get_property"
    .zero 23
    .ascii "napi_get_property_names"
    .zero 17
    .ascii "napi_get_prototype"
    .zero 22
    .ascii "napi_get_reference_value"
    .zero 16
    .ascii "napi_get_typedarray_info"
    .zero 16
    .ascii "napi_get_undefined"
    .zero 22
    .ascii "napi_get_value_bigint_int64"
    .zero 13
    .ascii "napi_get_value_bool"
    .zero 21
    .ascii "napi_get_value_double"
    .zero 19
    .ascii "napi_get_value_string_utf16"
    .zero 13
    .ascii "napi_get_value_string_utf8"
    .zero 14
    .ascii "napi_get_value_uint32"
    .zero 19
    .ascii "napi_instanceof"
    .zero 25
    .ascii "napi_is_array"
    .zero 27
    .ascii "napi_is_date"
    .zero 28
    .ascii "napi_is_exception_pending"
    .zero 15
    .ascii "napi_set_element"
    .zero 24
    .ascii "napi_set_named_property"
    .zero 17
    .ascii "napi_set_property"
    .zero 23
    .ascii "napi_strict_equals"
    .zero 22
    .ascii "napi_typeof"
    .zero 29

    .text
    .globl SYM(az_napicalls)
SYM(az_napicalls):
    AZ_ADR x0, SYM(aznct_hdr)
    ret
    AZ_DATA
    .globl SYM(aznct_base)
    .p2align 3
SYM(aznct_base):
    .quad CTR(napi_call_function)
    .quad CTR(napi_coerce_to_bool)
    .quad CTR(napi_coerce_to_number)
    .quad CTR(napi_coerce_to_string)
    .quad CTR(napi_create_array)
    .quad CTR(napi_create_array_with_length)
    .quad CTR(napi_create_arraybuffer)
    .quad CTR(napi_create_bigint_int64)
    .quad CTR(napi_create_double)
    .quad CTR(napi_create_function)
    .quad CTR(napi_create_object)
    .quad CTR(napi_create_reference)
    .quad CTR(napi_create_string_utf8)
    .quad CTR(napi_define_properties)
    .quad CTR(napi_delete_reference)
    .quad CTR(napi_get_and_clear_last_exception)
    .quad CTR(napi_get_array_length)
    .quad CTR(napi_get_boolean)
    .quad CTR(napi_get_cb_info)
    .quad CTR(napi_get_element)
    .quad CTR(napi_get_global)
    .quad CTR(napi_get_named_property)
    .quad CTR(napi_get_null)
    .quad CTR(napi_get_property)
    .quad CTR(napi_get_property_names)
    .quad CTR(napi_get_prototype)
    .quad CTR(napi_get_reference_value)
    .quad CTR(napi_get_typedarray_info)
    .quad CTR(napi_get_undefined)
    .quad CTR(napi_get_value_bigint_int64)
    .quad CTR(napi_get_value_bool)
    .quad CTR(napi_get_value_double)
    .quad CTR(napi_get_value_string_utf16)
    .quad CTR(napi_get_value_string_utf8)
    .quad CTR(napi_get_value_uint32)
    .quad CTR(napi_instanceof)
    .quad CTR(napi_is_array)
    .quad CTR(napi_is_date)
    .quad CTR(napi_is_exception_pending)
    .quad CTR(napi_set_element)
    .quad CTR(napi_set_named_property)
    .quad CTR(napi_set_property)
    .quad CTR(napi_strict_equals)
    .quad CTR(napi_typeof)

    AZ_WDATA
    .p2align 3
SYM(aznct_hdr):
    .quad 44
    .quad SYM(aznct_base)
    .quad SYM(aznct_names)

# AsmZod binary format

Contract between the TS encoder (`src/codec.ts`) and the ARM64 engine (`asm/`).
All multi-byte integers are little-endian. Unaligned loads are permitted.

## Value encoding (input values, output values, embedded literals, issues)

```
Value := tag:u8 payload...
tag 0x00 UNDEFINED
tag 0x01 NULL
tag 0x02 BOOL      u8 (0/1)
tag 0x03 F64       f64
tag 0x04 STRING    u64 len + utf8 bytes
tag 0x05 BIGINT    i64
tag 0x06 OBJECT    u64 nfields + field*
                   field := u64 keylen + utf8 key + Value
tag 0x07 ARRAY     u64 nelems + Value*
tag 0x08 HOSTREF   u64 index   (index into JS-side host value table;
                                used for symbols, Dates, class instances,
                                functions, anything not serializable)
```

## Schema bytecode

Blob of nodes, children referenced by u64 byte offsets relative to blob start.
Root node offset is implicit 0. Strings embedded as `u64 len + bytes`.

```
Node := opcode:u8 fields...

0x01 STRING        u8 nchecks + check*
0x02 NUMBER        u8 nchecks + check*
0x03 BOOLEAN
0x04 BIGINT        u8 nchecks + check*          (i64 range only)
0x05 OBJECT        u8 mode(0=strip 1=strict 2=passthrough)
                   u64 catchall_off (0 = none)
                   u64 nfields + [u64 namelen + name + u64 field_off]*
0x06 ARRAY         u64 elem_off + u64 min + u64 max   (u64_MAX = absent)
0x07 UNION         u64 nopts + u64 opt_off*
0x08 DISCUNION     u64 dnamelen + dname + u64 nmap
                   + [u64 klen + key + u64 opt_off]*
0x09 LITERAL       embedded Value (comparable tags only: null/bool/f64/str/bigint/undefined)
0x0A ENUM          u64 n + [u64 len + bytes]*
0x0B OPTIONAL      u64 inner
0x0C NULLABLE      u64 inner
0x0D DEFAULT       u64 inner + embedded Value (applied when input is UNDEFINED)
0x0E CATCH         u64 inner + embedded Value (result on inner failure)
0x0F REFINE        u64 inner + u64 cb_id + u64 msglen + msg
0x10 TRANSFORM     u64 inner + u64 cb_id
0x11 PIPE          u64 in_off + u64 out_off
0x12 INTERSECT     u64 left + u64 right           (mergeable objects only v1)
0x13 TUPLE         u64 n + u64 item_off* + u64 rest_off (0 = none)
0x14 RECORD        u64 key_off + u64 val_off      (key_off 0 = unconstrained)
0x15 ANY
0x16 NEVER
0x17 NULL_T
0x18 UNDEF_T
0x19 NAN
0x1A LAZY          u64 cb_id                       (cb_lazy -> node ptr)
0x1B INSTANCEOF    u64 cb_id + u64 namelen + name  (input must be HOSTREF)
0x1C COERCE_STR    u64 inner
0x1D COERCE_NUM    u64 inner
0x1E COERCE_BOOL   u64 inner
0x1F COERCE_BIGINT u64 inner
0x20 DATE          u8 nchecks + check*             (input must be HOSTREF of
                                                    kind date; checks via cb)
0x21 SYMBOL                                          (HOSTREF kind symbol)
0x22 CUSTOM        u64 cb_id + u64 msglen + msg    (cb_custom -> bool)
```

## Check records

`check := u8 code + u64 msglen + msgbytes + params`
(msglen 0 = engine default message)

String checks (node 0x01):
```
0x01 MIN         u64 n   (counted in UTF-16 code units, matching JS .length)
0x02 MAX         u64 n
0x03 LENGTH      u64 n
0x04 EMAIL
0x05 UUID        u8 version (0 = any)
0x06 URL
0x07 STARTSWITH  u64 len + bytes
0x08 ENDSWITH    u64 len + bytes
0x09 INCLUDES    u64 len + bytes
0x0A REGEX       u64 cb_id            (cb_host kind 0)
0x0B LOWERCASE   (ASCII fast path; non-ASCII cased chars -> check via bytes)
0x0C UPPERCASE
0x0D IPV4
0x0E IPV6        (simplified)
0x0F ULID
0x10 NANOID
0x11 CUID2
0x12 BASE64
0x13 HEX
0x14 DATETIME    (ISO 8601)
0x15 DATESTR     (YYYY-MM-DD)
0x16 TIMESTR     (HH:MM[:SS[.fff]])
```

Number checks (node 0x02):
```
0x01 GT   f64
0x02 GTE  f64
0x03 LT   f64
0x04 LTE  f64
0x05 INT
0x06 FINITE
0x07 MULTIPLEOF f64
0x08 SAFEINT
```

Bigint checks (node 0x04): same codes, i64 params.

Date checks (node 0x20):
```
0x01 MINDATE  f64 epoch-ms
0x02 MAXDATE  f64 epoch-ms
```

## FFI

```c
// cb table: array of 4 function pointers, passed via x6
cb_refine    (u32 id, u64 valptr) -> u32
cb_transform (u32 id, u64 valptr, u64 outptr, u64 outcap) -> i64   // bytes | -ENOSPC
cb_lazy      (u32 id) -> u64   // -> node ptr (JS-owned compiled blob, valid during call)
cb_host      (u32 kind, u64 a, u64 b, u64 c) -> i64
//   kind 0: regex    a=cb_id b=strptr c=strlen   -> 0/1
//   kind 1: instanceof a=cb_id b=hostref_idx     -> 0/1
//   kind 2: hostref kind check  a=kind(1=sym,2=date,3=map,4=set) b=hostref_idx -> 0/1
//   kind 3: date getTime   a=hostref_idx -> f64 bits
//   kind 4: custom     a=cb_id b=valptr          -> 0/1
//   kind 5: hostref to primitive  a=hostref_idx b=target(1=str,2=num,3=bool,4=bigint)
//           -> i64: for num/bool/bigint returns bits/value; for str writes via
//              outptr in c... simpler: kind 5 writes tagged value to (b=outptr,c=outcap) -> len|-ENOSPC
//           (used by coerce on HOSTREF values: String(x), Number(x) etc.)

i64 az_parse(
  x0 schema_node_ptr,   // blob_base + root offset (absolute ptr to node)
  x1 input_ptr,         // tagged Value
  x2 out_val_ptr, x3 out_val_cap,
  x4 out_err_ptr, x5 out_err_cap,
  x6 cb_table_ptr
)
// ret >=0 : success, value byte length written at out_val
// ret -2  : validation failed; out_err holds [u64 count][issues...]
// ret -3  : out_val too small  (retry bigger)
// ret -4  : out_err too small
// ret -1  : malformed bytecode/input
```

### out_err buffer layout
```
+0     u64 issue_count
+8     u64 path_depth        (engine-managed, reset each call)
+16    path stack: 128 entries x 24B {u64 kind(0=key,1=index), u64 a, u64 b}
        kind=key: a=keyptr b=keylen   kind=index: a=idx
+3088  issue blobs: concatenated tagged OBJECT Values, issue_count of them
```
Scratch region for speculative issues (union arms, catch) grows down from
`out_err_ptr + out_err_cap`.

### out_val buffer
Result tagged Value on success. For OBJECT strip mode the engine emits only
known fields (schema order); passthrough appends unknown input fields.
```
```

// runners.s — check record dispatchers
// check := u8 code + u64 msglen + msg + params
// x27/x28 used for cursor/count (saved/restored); ctx regs untouched
    .text
    .p2align 2

// ============ az_run_strchecks(x0=chkptr, x1=count, x2=strptr, x3=strlen)
// -> x0: 0 ok / -2 invalid / -4 enospc
    .globl _az_run_strchecks
_az_run_strchecks:
    stp x29, x30, [sp, #-512]!
    mov x29, sp
    stp x27, x28, [sp, #16]
    stp x2, x3, [sp, #32]        // strptr, strlen
    mov x27, x0
    mov x28, x1
    // units = utf16 units
    mov x0, x2
    mov x1, x3
    bl _az_utf16_units
    str x0, [sp, #48]
.Lsc_loop:
    cbz x28, .Lsc_ok
    ldrb w9, [x27]
    ldr x10, [x27, #1]           // msglen
    add x11, x27, #9
    add x12, x11, x10            // params
    stp x11, x10, [sp, #56]      // msgptr,msglen
    str x12, [sp, #72]           // params
    str w9, [sp, #80]            // code
    // dispatch
    cmp w9, #3
    b.ls .Lsc_size
    cmp w9, #4
    b.eq .Lsc_email
    cmp w9, #5
    b.eq .Lsc_uuid
    cmp w9, #6
    b.eq .Lsc_url
    cmp w9, #9
    b.ls .Lsc_swew               // 7,8,9
    cmp w9, #0x0A
    b.eq .Lsc_regex
    cmp w9, #0x0C
    b.ls .Lsc_case               // 0x0B,0x0C
    cmp w9, #0x0D
    b.eq .Lsc_ipv4
    cmp w9, #0x0E
    b.eq .Lsc_ipv6
    cmp w9, #0x0F
    b.eq .Lsc_ulid
    cmp w9, #0x10
    b.eq .Lsc_nanoid
    cmp w9, #0x11
    b.eq .Lsc_cuid2
    cmp w9, #0x12
    b.eq .Lsc_b64
    cmp w9, #0x13
    b.eq .Lsc_hex
    cmp w9, #0x14
    b.eq .Lsc_dt
    cmp w9, #0x15
    b.eq .Lsc_ds
    cmp w9, #0x16
    b.eq .Lsc_ts
    b .Lsc_next0                 // unknown check: skip, advance 0 params

// ---- size checks (MIN=1 MAX=2 LENGTH=3), param u64 ----
.Lsc_size:
    ldr x12, [sp, #72]
    ldr x13, [x12]               // n
    ldr x14, [sp, #48]           // units
    cmp w9, #1
    b.eq .Lsc_min
    cmp w9, #2
    b.eq .Lsc_max
    // LENGTH exact
    cmp x14, x13
    b.eq .Lsc_next8
    b.hi .Lsc_len_big
    adrp x1, ams_exactly@PAGE
    add x1, x1, ams_exactly@PAGEOFF
    mov x2, #29
    adrp x4, ams_chars@PAGE
    add x4, x4, ams_chars@PAGEOFF
    mov x5, #14
    b .Lsc_sizefail_small
.Lsc_len_big:
    adrp x1, ams_exactly@PAGE
    add x1, x1, ams_exactly@PAGEOFF
    mov x2, #29
    adrp x4, ams_chars@PAGE
    add x4, x4, ams_chars@PAGEOFF
    mov x5, #14
    b .Lsc_sizefail_big
.Lsc_min:
    cmp x14, x13
    b.hs .Lsc_next8
    adrp x1, ams_atleast@PAGE
    add x1, x1, ams_atleast@PAGEOFF
    mov x2, #29
    adrp x4, ams_chars@PAGE
    add x4, x4, ams_chars@PAGEOFF
    mov x5, #14
    b .Lsc_sizefail_small
.Lsc_max:
    cmp x14, x13
    b.ls .Lsc_next8
    adrp x1, ams_atmost@PAGE
    add x1, x1, ams_atmost@PAGEOFF
    mov x2, #29
    adrp x4, ams_chars@PAGE
    add x4, x4, ams_chars@PAGEOFF
    mov x5, #14
    b .Lsc_sizefail_big
.Lsc_sizefail_small:
    // build msg (custom override if msglen>0)
    ldp x6, x7, [sp, #56]
    cbnz x7, .Lsc_sf_have
    add x0, sp, #96
    mov x3, x13
    bl _az_msg_size
    mov x6, x0                  // len
    add x0, sp, #96
    mov x7, x6
    mov x6, x0
.Lsc_sf_have:
    ldr w9, [sp, #80]
    mov x3, x13
    ucvtf d0, x3
    fmov x3, d0                  // bound bits (n as f64)
    mov x0, #8                   // too_small
    adrp x1, .Lty_string@PAGE
    add x1, x1, .Lty_string@PAGEOFF
    mov x2, #6
    mov w4, #1                   // inclusive
    ldr w9, [sp, #80]
    cmp w9, #3
    cset w5, eq                  // exact iff LENGTH
    bl _az_issue_size
    cbnz x0, .Lsc_retx
    mov x0, #-2
    b .Lsc_retx
.Lsc_sizefail_big:
    ldp x6, x7, [sp, #56]
    cbnz x7, .Lsc_sf_have2
    add x0, sp, #96
    mov x3, x13
    bl _az_msg_size
    mov x6, x0
    add x0, sp, #96
    mov x7, x6
    mov x6, x0
.Lsc_sf_have2:
    mov x3, x13
    ucvtf d0, x3
    fmov x3, d0
    mov x0, #9                   // too_big
    adrp x1, .Lty_string@PAGE
    add x1, x1, .Lty_string@PAGEOFF
    mov x2, #6
    mov w4, #1
    ldr w9, [sp, #80]
    cmp w9, #3
    cset w5, eq                  // exact iff LENGTH
    bl _az_issue_size
    cbnz x0, .Lsc_retx
    mov x0, #-2
    b .Lsc_retx

// ---- format checks: shared tail ----
// validator result in w0: 0 -> issue invalid_string {validation, msg}
// each format site sets x9=advance
.Lsc_email:
    ldp x0, x1, [sp, #32]
    bl _az_is_email
    mov x9, #0
    cbz w0, .Lsc_fmt_email
    b .Lsc_next
.Lsc_fmt_email:
    adrp x9, .Lv_email@PAGE
    add x9, x9, .Lv_email@PAGEOFF
    mov x10, #5
    adrp x11, .Lm_email@PAGE
    add x11, x11, .Lm_email@PAGEOFF
    mov x12, #13
    b .Lsc_fmt_fail
.Lsc_uuid:
    ldp x0, x1, [sp, #32]
    ldr x12, [sp, #72]
    ldrb w2, [x12]               // version
    bl _az_is_uuid
    mov x9, #1                   // param u8
    cbz w0, .Lsc_fmt_uuid
    b .Lsc_next
.Lsc_fmt_uuid:
    adrp x9, .Lv_uuid@PAGE
    add x9, x9, .Lv_uuid@PAGEOFF
    mov x10, #4
    adrp x11, .Lm_uuid@PAGE
    add x11, x11, .Lm_uuid@PAGEOFF
    mov x12, #12
    b .Lsc_fmt_fail
.Lsc_url:
    ldp x0, x1, [sp, #32]
    bl _az_is_url
    mov x9, #0
    cbz w0, .Lsc_fmt_url
    b .Lsc_next
.Lsc_fmt_url:
    adrp x9, .Lv_url@PAGE
    add x9, x9, .Lv_url@PAGEOFF
    mov x10, #3
    adrp x11, .Lm_url@PAGE
    add x11, x11, .Lm_url@PAGEOFF
    mov x12, #11
    b .Lsc_fmt_fail
.Lsc_ipv4:
    ldp x0, x1, [sp, #32]
    bl _az_is_ipv4
    mov x9, #0
    cbz w0, .Lsc_fmt_ipv4
    b .Lsc_next
.Lsc_fmt_ipv4:
    adrp x9, .Lv_ipv4@PAGE
    add x9, x9, .Lv_ipv4@PAGEOFF
    mov x10, #4
    adrp x11, .Lm_ip@PAGE
    add x11, x11, .Lm_ip@PAGEOFF
    mov x12, #18
    b .Lsc_fmt_fail
.Lsc_ipv6:
    ldp x0, x1, [sp, #32]
    bl _az_is_ipv6
    mov x9, #0
    cbz w0, .Lsc_fmt_ipv6
    b .Lsc_next
.Lsc_fmt_ipv6:
    adrp x9, .Lv_ipv6@PAGE
    add x9, x9, .Lv_ipv6@PAGEOFF
    mov x10, #4
    adrp x11, .Lm_ip@PAGE
    add x11, x11, .Lm_ip@PAGEOFF
    mov x12, #18
    b .Lsc_fmt_fail
.Lsc_ulid:
    ldp x0, x1, [sp, #32]
    bl _az_is_ulid
    mov x9, #0
    cbz w0, .Lsc_fmt_ulid
    b .Lsc_next
.Lsc_fmt_ulid:
    adrp x9, .Lv_ulid@PAGE
    add x9, x9, .Lv_ulid@PAGEOFF
    mov x10, #4
    adrp x11, .Lm_ulid@PAGE
    add x11, x11, .Lm_ulid@PAGEOFF
    mov x12, #12
    b .Lsc_fmt_fail
.Lsc_nanoid:
    ldp x0, x1, [sp, #32]
    bl _az_is_nanoid
    mov x9, #0
    cbz w0, .Lsc_fmt_nanoid
    b .Lsc_next
.Lsc_fmt_nanoid:
    adrp x9, .Lv_nanoid@PAGE
    add x9, x9, .Lv_nanoid@PAGEOFF
    mov x10, #6
    adrp x11, .Lm_nanoid@PAGE
    add x11, x11, .Lm_nanoid@PAGEOFF
    mov x12, #14
    b .Lsc_fmt_fail
.Lsc_cuid2:
    ldp x0, x1, [sp, #32]
    bl _az_is_cuid2
    mov x9, #0
    cbz w0, .Lsc_fmt_cuid2
    b .Lsc_next
.Lsc_fmt_cuid2:
    adrp x9, .Lv_cuid2@PAGE
    add x9, x9, .Lv_cuid2@PAGEOFF
    mov x10, #5
    adrp x11, .Lm_cuid2@PAGE
    add x11, x11, .Lm_cuid2@PAGEOFF
    mov x12, #13
    b .Lsc_fmt_fail
.Lsc_b64:
    ldp x0, x1, [sp, #32]
    bl _az_is_base64
    mov x9, #0
    cbz w0, .Lsc_fmt_b64
    b .Lsc_next
.Lsc_fmt_b64:
    adrp x9, .Lv_base64@PAGE
    add x9, x9, .Lv_base64@PAGEOFF
    mov x10, #6
    adrp x11, .Lm_base64@PAGE
    add x11, x11, .Lm_base64@PAGEOFF
    mov x12, #14
    b .Lsc_fmt_fail
.Lsc_hex:
    ldp x0, x1, [sp, #32]
    bl _az_is_hex
    mov x9, #0
    cbz w0, .Lsc_fmt_hex
    b .Lsc_next
.Lsc_fmt_hex:
    adrp x9, .Lv_hex@PAGE
    add x9, x9, .Lv_hex@PAGEOFF
    mov x10, #3
    adrp x11, .Lm_hex@PAGE
    add x11, x11, .Lm_hex@PAGEOFF
    mov x12, #11
    b .Lsc_fmt_fail
.Lsc_dt:
    ldp x0, x1, [sp, #32]
    ldr x12, [sp, #72]
    ldrb w2, [x12]               // flags
    bl _az_is_datetime
    mov x9, #1
    cbz w0, .Lsc_fmt_dt
    b .Lsc_next
.Lsc_fmt_dt:
    adrp x9, .Lv_datetime@PAGE
    add x9, x9, .Lv_datetime@PAGEOFF
    mov x10, #8
    adrp x11, .Lm_datetime@PAGE
    add x11, x11, .Lm_datetime@PAGEOFF
    mov x12, #16
    b .Lsc_fmt_fail
.Lsc_ds:
    ldp x0, x1, [sp, #32]
    bl _az_is_datestr
    mov x9, #0
    cbz w0, .Lsc_fmt_ds
    b .Lsc_next
.Lsc_fmt_ds:
    adrp x9, .Lv_date@PAGE
    add x9, x9, .Lv_date@PAGEOFF
    mov x10, #4
    adrp x11, .Lm_date@PAGE
    add x11, x11, .Lm_date@PAGEOFF
    mov x12, #12
    b .Lsc_fmt_fail
.Lsc_ts:
    ldp x0, x1, [sp, #32]
    bl _az_is_timestr
    mov x9, #0
    cbz w0, .Lsc_fmt_ts
    b .Lsc_next
.Lsc_fmt_ts:
    adrp x9, .Lv_time@PAGE
    add x9, x9, .Lv_time@PAGEOFF
    mov x10, #4
    adrp x11, .Lm_time@PAGE
    add x11, x11, .Lm_time@PAGEOFF
    mov x12, #12
    b .Lsc_fmt_fail

// ---- startswith/endswith/includes (param: u64 len + bytes) ----
.Lsc_swew:
    ldr x12, [sp, #72]
    ldr x13, [x12]               // plen
    add x14, x12, #8             // pbytes
    ldp x15, x16, [sp, #32]      // strptr, strlen
    cmp x13, x16
    b.hi .Lsc_se_fail            // needle longer -> fail
    cmp w9, #7
    b.eq .Lsc_sw
    cmp w9, #8
    b.eq .Lsc_ew
    // includes
    mov x0, x15
    mov x1, x16
    mov x2, x14
    mov x3, x13
    bl _az_memmem
    cbz w0, .Lsc_se_fail_inc
    b .Lsc_nextv
.Lsc_sw:
    mov x0, x15
    mov x1, x14
    mov x2, x13
    bl _az_memeq
    cbz w0, .Lsc_se_fail_sw
    b .Lsc_nextv
.Lsc_ew:
    sub x0, x16, x13
    add x0, x15, x0              // tail ptr
    mov x1, x14
    mov x2, x13
    bl _az_memeq
    cbz w0, .Lsc_se_fail_ew
    b .Lsc_nextv
.Lsc_se_fail_sw:
    adrp x9, .Lv_startswith@PAGE
    add x9, x9, .Lv_startswith@PAGEOFF
    mov x10, #10
    adrp x11, .Lm_sw_pre@PAGE
    add x11, x11, .Lm_sw_pre@PAGEOFF
    mov x12, #31
    b .Lsc_se_msg
.Lsc_se_fail_ew:
    adrp x9, .Lv_endswith@PAGE
    add x9, x9, .Lv_endswith@PAGEOFF
    mov x10, #9
    adrp x11, .Lm_ew_pre@PAGE
    add x11, x11, .Lm_ew_pre@PAGEOFF
    mov x12, #29
    b .Lsc_se_msg
.Lsc_se_fail_inc:
    adrp x9, .Lv_includes@PAGE
    add x9, x9, .Lv_includes@PAGEOFF
    mov x10, #8
    adrp x11, .Lm_inc_pre@PAGE
    add x11, x11, .Lm_inc_pre@PAGEOFF
    mov x12, #28
    b .Lsc_se_msg
.Lsc_se_fail:
    // needle > haystack: same issue path, pick by code
    ldr w9, [sp, #80]
    cmp w9, #7
    b.eq .Lsc_se_fail_sw
    cmp w9, #8
    b.eq .Lsc_se_fail_ew
    b .Lsc_se_fail_inc
.Lsc_se_msg:
    // x9=vname, x10=vlen, x11=prefix, x12=prelen
    // build "prefix \"needle\"" into buf; custom msg overrides
    stp x9, x10, [sp, #88]
    ldp x6, x7, [sp, #56]        // custom msg
    cbnz x7, .Lsc_se_issue
    add x10, sp, #104            // buf past the x88/x96 saves
    mov x13, x11
    mov x16, x12
    mov x11, x13
    mov x12, x16
    // cat prefix
    mov x0, x10
    mov x1, x11
    mov x2, x12
    bl _az_cat
    mov x10, x0
    mov w13, #'"'
    strb w13, [x10], #1
    // needle (reload)
    ldr x12, [sp, #72]
    ldr x1, [x12]
    add x14, x12, #8
    mov x0, x10
    mov x2, x1
    mov x1, x14
    bl _az_cat
    mov x10, x0
    mov w13, #'"'
    strb w13, [x10], #1
    add x6, sp, #104
    sub x7, x10, x6
.Lsc_se_issue:
    ldp x0, x1, [sp, #88]
    mov x2, x6
    mov x3, x7
    bl _az_issue_invstr
    cbnz x0, .Lsc_retx
    mov x0, #-2
    b .Lsc_retx

// ---- regex (param u64 cbid) ----
.Lsc_regex:
    ldr x12, [sp, #72]
    ldr x13, [x12]               // cbid
    ldp x14, x15, [sp, #32]
    ldr x16, [x24, #24]          // cb_host
    mov x0, #0                   // kind 0 regex
    mov x1, x13
    mov x2, x14
    mov x3, x15
    blr x16
    mov x9, #8
    cbz w0, .Lsc_fmt_regex
    b .Lsc_next
.Lsc_fmt_regex:
    adrp x9, .Lv_regex@PAGE
    add x9, x9, .Lv_regex@PAGEOFF
    mov x10, #5
    adrp x11, .Lm_regex@PAGE
    add x11, x11, .Lm_regex@PAGEOFF
    mov x12, #7
    b .Lsc_fmt_fail

// ---- lowercase/uppercase (no params) ----
.Lsc_case:
    ldp x14, x15, [sp, #32]
    mov x16, #0
    mov w10, #0                  // found bad
    ldr w9, [sp, #80]
    cmp w9, #0x0B
    b.eq .Lsc_lc_scan
    // uppercase: any 'a'-'z' -> bad
.Lsc_uc_scan:
    cmp x16, x15
    b.hs .Lsc_case_done
    ldrb w11, [x14, x16]
    cmp w11, #'a'
    b.lo .Lsc_uc_n
    cmp w11, #'z'
    b.ls .Lsc_case_bad
.Lsc_uc_n:
    add x16, x16, #1
    b .Lsc_uc_scan
.Lsc_lc_scan:
    cmp x16, x15
    b.hs .Lsc_case_done
    ldrb w11, [x14, x16]
    cmp w11, #'A'
    b.lo .Lsc_lc_n
    cmp w11, #'Z'
    b.ls .Lsc_case_bad
.Lsc_lc_n:
    add x16, x16, #1
    b .Lsc_lc_scan
.Lsc_case_bad:
    mov w10, #1
.Lsc_case_done:
    mov x9, #0
    cbz w10, .Lsc_next
    ldr w9, [sp, #80]
    cmp w9, #0x0B
    b.eq .Lsc_fmt_lc
    adrp x9, .Lv_uppercase@PAGE
    add x9, x9, .Lv_uppercase@PAGEOFF
    mov x10, #9
    adrp x11, .Lm_uc@PAGE
    add x11, x11, .Lm_uc@PAGEOFF
    mov x12, #50
    b .Lsc_fmt_fail
.Lsc_fmt_lc:
    adrp x9, .Lv_lowercase@PAGE
    add x9, x9, .Lv_lowercase@PAGEOFF
    mov x10, #9
    adrp x11, .Lm_lc@PAGE
    add x11, x11, .Lm_lc@PAGEOFF
    mov x12, #50
    b .Lsc_fmt_fail

// shared format-fail tail: x9=vname x10=vlen x11=dmsg x12=dmsglen
.Lsc_fmt_fail:
    ldp x2, x3, [sp, #56]        // custom msg override
    cbnz x3, .Lsc_ff2
    mov x2, x11
    mov x3, x12
.Lsc_ff2:
    mov x1, x10
    mov x0, x9
    bl _az_issue_invstr
    cbnz x0, .Lsc_retx
    mov x0, #-2
    b .Lsc_retx

// advance: x9 = param size (or .Lsc_nextv recomputes for var-len)
.Lsc_next:
    ldr x12, [sp, #72]
    add x27, x12, x9
    b .Lsc_cont
.Lsc_nextv:
    // var-len param: u64 len + bytes
    ldr x12, [sp, #72]
    ldr x13, [x12]
    add x27, x12, x13
    add x27, x27, #8
    b .Lsc_cont
.Lsc_next0:
    ldr x27, [sp, #72]
    b .Lsc_cont
.Lsc_next8:
    ldr x12, [sp, #72]
    add x27, x12, #8
.Lsc_cont:
    sub x28, x28, #1
    b .Lsc_loop
.Lsc_ok:
    mov x0, #0
.Lsc_retx:
    ldp x27, x28, [sp, #16]
    ldp x29, x30, [sp]
    add sp, sp, #512
    ret

// ============ az_run_numchecks(x0=chkptr,x1=count,d0=val,x2=valptr)
    .globl _az_run_numchecks
_az_run_numchecks:
    stp x29, x30, [sp, #-512]!
    mov x29, sp
    stp x27, x28, [sp, #16]
    str d0, [sp, #32]
    str x2, [sp, #40]            // valptr
    mov x27, x0
    mov x28, x1
.Lnc_loop:
    cbz x28, .Lnc_ok
    ldrb w9, [x27]
    ldr x10, [x27, #1]
    add x11, x27, #9
    add x12, x11, x10
    stp x11, x10, [sp, #56]
    str x12, [sp, #72]
    str w9, [sp, #80]
    ldr d0, [sp, #32]
    cmp w9, #4
    b.ls .Lnc_cmp
    cmp w9, #5
    b.eq .Lnc_int
    cmp w9, #6
    b.eq .Lnc_finite
    cmp w9, #7
    b.eq .Lnc_mult
    cmp w9, #8
    b.eq .Lnc_safe
    b .Lnc_next0
.Lnc_cmp:
    ldr d1, [x12]                // bound
    cmp w9, #1
    b.eq .Lnc_gt
    cmp w9, #2
    b.eq .Lnc_gte
    cmp w9, #3
    b.eq .Lnc_lt
    // LTE
    fcmp d0, d1
    b.ls .Lnc_next8
    adrp x1, amn_lte@PAGE
    add x1, x1, amn_lte@PAGEOFF
    mov x2, #37
    mov w4, #1
    mov x0, #9
    b .Lnc_boundfail
.Lnc_gt:
    fcmp d0, d1
    b.gt .Lnc_next8
    adrp x1, amn_gt@PAGE
    add x1, x1, amn_gt@PAGEOFF
    mov x2, #28
    mov w4, #0
    mov x0, #8
    b .Lnc_boundfail
.Lnc_gte:
    fcmp d0, d1
    b.ge .Lnc_next8
    adrp x1, amn_gte@PAGE
    add x1, x1, amn_gte@PAGEOFF
    mov x2, #40
    mov w4, #1
    mov x0, #8
    b .Lnc_boundfail
.Lnc_lt:
    fcmp d0, d1
    b.mi .Lnc_next8
    adrp x1, amn_lt@PAGE
    add x1, x1, amn_lt@PAGEOFF
    mov x2, #25
    mov w4, #0
    mov x0, #9
    b .Lnc_boundfail
.Lnc_boundfail:
    // x0=code x1=prefix x2=prelen w4=incl ; bound d1 ; type "number"
    str x0, [sp, #88]
    stp x1, x2, [sp, #96]
    str w4, [sp, #112]
    fmov x9, d1
    str x9, [sp, #116]           // bound bits (unaligned ok on stack? keep aligned)
    // msg: custom or build "prefix<bound>"
    ldp x6, x7, [sp, #56]
    cbnz x7, .Lnc_bf_have
    add x0, sp, #128
    fmov d0, d1
    mov x3, #0
    mov x4, #0
    bl _az_msg_f64               // needs (buf,prefix,prelen,d0,suffix,suflen)
    // fix args: (x0=buf, x1=prefix,x2=prelen, d0, x3=suffix,x4=suflen)
    mov x6, x0
    add x0, sp, #128
    mov x7, x6
    mov x6, x0
.Lnc_bf_have:
    ldr x0, [sp, #88]
    adrp x1, .Lty_number@PAGE
    add x1, x1, .Lty_number@PAGEOFF
    mov x2, #6
    ldr x3, [sp, #116]
    ldr w4, [sp, #112]
    mov w5, #0
    bl _az_issue_size
    cbnz x0, .Lnc_retx
    mov x0, #-2
    b .Lnc_retx
.Lnc_int:
    frintm d1, d0
    fcmp d0, d1
    b.ne .Lnc_int_fail
    // also require finite: |d0| < inf
    mov x9, #0x7FF0000000000000
    fmov d1, x9
    fabs d2, d0
    fcmp d2, d1
    b.hs .Lnc_int_fail
    b .Lnc_next0
.Lnc_int_fail:
    // invalid_type expected "integer"
    adrp x0, .Lty_integer@PAGE
    add x0, x0, .Lty_integer@PAGEOFF
    mov x1, #7
    mov w2, #3                   // tag f64
    ldr x3, [sp, #40]
    bl _az_issue_type
    cbnz x0, .Lnc_retx
    mov x0, #-2
    b .Lnc_retx
.Lnc_finite:
    mov x9, #0x7FF0000000000000
    fmov d1, x9
    fabs d2, d0
    fcmp d2, d1
    b.lo .Lnc_next0
    fcmp d0, d0
    b.vc .Lnc_finite_ok          // NaN is "finite fail" too? NaN guarded earlier; keep
    b .Lnc_finite_fail
.Lnc_finite_ok:
    fcmp d2, d1
    b.lo .Lnc_next0
.Lnc_finite_fail:
    mov x0, #12                  // not_finite
    mov x1, #0
    mov x2, #0
    bl _az_issue_begin
    cbnz x0, .Lnc_retx
    bl _az_issue_commit
    mov x0, #-2
    b .Lnc_retx
.Lnc_mult:
    ldr d1, [x12]                // m
    fdiv d2, d0, d1
    frintz d2, d2                // trunc(d0/m)
    fmul d2, d2, d1
    fsub d2, d0, d2              // remainder
    fcmp d2, #0.0
    b.eq .Lnc_next8
    // not_multiple_of {multipleOf: m} msg "Number must be a multiple of m"
    fmov x9, d1
    str x9, [sp, #88]
    ldp x6, x7, [sp, #56]
    cbnz x7, .Lnc_m_have
    add x0, sp, #128
    adrp x1, amn_mult@PAGE
    add x1, x1, amn_mult@PAGEOFF
    mov x2, #29
    mov x3, #0
    mov x4, #0
    fmov d0, d1
    bl _az_msg_f64
    mov x6, x0
    add x0, sp, #128
    mov x7, x6
    mov x6, x0
.Lnc_m_have:
    mov x0, #11
    mov x1, x6
    mov x2, x7
    bl _az_issue_begin
    cbnz x0, .Lnc_retx
    adrp x0, .Lk_multof@PAGE
    add x0, x0, .Lk_multof@PAGEOFF
    mov x1, #10
    ldr d0, [sp, #88]
    bl _az_issue_f_f64
    cbnz x0, .Lnc_retx
    bl _az_issue_commit
    mov x0, #-2
    b .Lnc_retx
.Lnc_safe:
    // int && |x| <= 2^53-1
    frintm d1, d0
    fcmp d0, d1
    b.ne .Lnc_int_fail
    mov x9, #0x433FFFFFFFFFFFFF  // 2^53-1
    fmov d1, x9
    fabs d2, d0
    fcmp d2, d1
    b.ls .Lnc_next0
    // too_small/too_big bound 2^53-1
    mov x9, #0x433FFFFFFFFFFFFF
    str x9, [sp, #116]
    fcmp d0, #0.0
    adrp x1, amn_lte@PAGE
    add x1, x1, amn_lte@PAGEOFF
    mov x2, #37
    mov x0, #9
    b.pl .Lnc_safe_b
    adrp x1, amn_gte@PAGE
    add x1, x1, amn_gte@PAGEOFF
    mov x2, #40
    mov x0, #8
.Lnc_safe_b:
    mov w4, #1
    b .Lnc_boundfail2
.Lnc_boundfail2:
    str x0, [sp, #88]
    stp x1, x2, [sp, #96]
    str w4, [sp, #112]
    ldp x6, x7, [sp, #56]
    cbnz x7, .Lnc_bf_have
    add x0, sp, #128
    ldr d0, [sp, #116]
    mov x3, #0
    mov x4, #0
    bl _az_msg_f64
    mov x6, x0
    add x0, sp, #128
    mov x7, x6
    mov x6, x0
    b .Lnc_bf_have

.Lnc_next0:
    ldr x27, [sp, #72]
    b .Lnc_cont
.Lnc_next8:
    ldr x12, [sp, #72]
    add x27, x12, #8
.Lnc_cont:
    sub x28, x28, #1
    b .Lnc_loop
.Lnc_ok:
    mov x0, #0
.Lnc_retx:
    ldp x27, x28, [sp, #16]
    ldp x29, x30, [sp]
    add sp, sp, #512
    ret

// ============ az_run_bigintchecks(x0=chkptr,x1=count,x2=i64 val,x3=valptr)
    .globl _az_run_bigintchecks
_az_run_bigintchecks:
    stp x29, x30, [sp, #-512]!
    mov x29, sp
    stp x27, x28, [sp, #16]
    stp x2, x3, [sp, #32]
    mov x27, x0
    mov x28, x1
.Lbc_loop:
    cbz x28, .Lbc_ok
    ldrb w9, [x27]
    ldr x10, [x27, #1]
    add x11, x27, #9
    add x12, x11, x10
    stp x11, x10, [sp, #56]
    str x12, [sp, #72]
    str w9, [sp, #80]
    ldr x13, [x12]               // i64 bound/param
    ldr x14, [sp, #32]           // val
    cmp w9, #4
    b.ls .Lbc_cmp
    cmp w9, #7
    b.eq .Lbc_mult
    b .Lbc_next0
.Lbc_cmp:
    cmp w9, #1
    b.eq .Lbc_gt
    cmp w9, #2
    b.eq .Lbc_gte
    cmp w9, #3
    b.eq .Lbc_lt
    // LTE
    cmp x14, x13
    b.le .Lbc_next8
    adrp x1, amb_lte@PAGE
    add x1, x1, amb_lte@PAGEOFF
    mov x2, #38
    mov w4, #1
    mov x0, #9
    b .Lbc_boundfail
.Lbc_gt:
    cmp x14, x13
    b.gt .Lbc_next8
    adrp x1, amb_gt@PAGE
    add x1, x1, amb_gt@PAGEOFF
    mov x2, #29
    mov w4, #0
    mov x0, #8
    b .Lbc_boundfail
.Lbc_gte:
    cmp x14, x13
    b.ge .Lbc_next8
    adrp x1, amb_gte@PAGE
    add x1, x1, amb_gte@PAGEOFF
    mov x2, #41
    mov w4, #1
    mov x0, #8
    b .Lbc_boundfail
.Lbc_lt:
    cmp x14, x13
    b.lt .Lbc_next8
    adrp x1, amb_lt@PAGE
    add x1, x1, amb_lt@PAGEOFF
    mov x2, #26
    mov w4, #0
    mov x0, #9
    b .Lbc_boundfail
.Lbc_boundfail:
    // x0=code x1=prefix x2=prelen w4=incl x13=bound(i64)
    str x0, [sp, #88]
    stp x1, x2, [sp, #96]
    str w4, [sp, #112]
    str x13, [sp, #116]
    ldp x6, x7, [sp, #56]
    cbnz x7, .Lbc_bf_have
    // build msg "prefix<N>" via sdec
    add x0, sp, #128
    mov x10, x0
    mov x11, x1
    mov x12, x2
.Lbc_m1:
    cbz x12, .Lbc_m2
    ldrb w15, [x11], #1
    strb w15, [x10], #1
    sub x12, x12, #1
    b .Lbc_m1
.Lbc_m2:
    ldr x0, [sp, #116]
    mov x1, x10
    bl _az_sdec
    add x10, x10, x0
    add x6, sp, #128
    sub x7, x10, x6
.Lbc_bf_have:
    // issue_size can't emit i64 bound -> manual: begin + f_i64 + type + incl
    ldr x0, [sp, #88]
    mov x1, x6
    mov x2, x7
    bl _az_issue_begin
    cbnz x0, .Lbc_retx
    ldr x10, [sp, #88]
    cmp x10, #9
    b.eq .Lbc_max
    adrp x0, ak_minimum@PAGE
    add x0, x0, ak_minimum@PAGEOFF
    mov x1, #7
    b .Lbc_b2
.Lbc_max:
    adrp x0, ak_maximum@PAGE
    add x0, x0, ak_maximum@PAGEOFF
    mov x1, #7
.Lbc_b2:
    ldr x2, [sp, #116]
    bl _az_issue_f_i64
    cbnz x0, .Lbc_retx
    adrp x0, ak_type@PAGE
    add x0, x0, ak_type@PAGEOFF
    mov x1, #4
    adrp x2, .Lty_bigint@PAGE
    add x2, x2, .Lty_bigint@PAGEOFF
    mov x3, #6
    bl _az_issue_f_str
    cbnz x0, .Lbc_retx
    adrp x0, ak_inclusive@PAGE
    add x0, x0, ak_inclusive@PAGEOFF
    mov x1, #9
    ldr w2, [sp, #112]
    bl _az_issue_f_bool
    cbnz x0, .Lbc_retx
    bl _az_issue_commit
    mov x0, #-2
    b .Lbc_retx
.Lbc_mult:
    // val % m != 0 -> not_multiple_of
    cbz x13, .Lbc_next8          // m==0: skip (avoid div0)
    sdiv x15, x14, x13
    msub x15, x15, x13, x14
    cbz x15, .Lbc_next8
    str x13, [sp, #116]
    ldp x6, x7, [sp, #56]
    cbnz x7, .Lbc_mb_have
    add x0, sp, #128
    mov x10, x0
    adrp x11, amb_mult@PAGE
    add x11, x11, amb_mult@PAGEOFF
    mov x12, #30
.Lbc_mm1:
    ldrb w15, [x11], #1
    strb w15, [x10], #1
    subs x12, x12, #1
    b.ne .Lbc_mm1
    ldr x0, [sp, #116]
    mov x1, x10
    bl _az_sdec
    add x10, x10, x0
    add x6, sp, #128
    sub x7, x10, x6
.Lbc_mb_have:
    mov x0, #11
    mov x1, x6
    mov x2, x7
    bl _az_issue_begin
    cbnz x0, .Lbc_retx
    adrp x0, .Lk_multof@PAGE
    add x0, x0, .Lk_multof@PAGEOFF
    mov x1, #10
    ldr x2, [sp, #116]
    bl _az_issue_f_i64
    cbnz x0, .Lbc_retx
    bl _az_issue_commit
    mov x0, #-2
    b .Lbc_retx
.Lbc_next0:
    ldr x27, [sp, #72]
    b .Lbc_cont
.Lbc_next8:
    ldr x12, [sp, #72]
    add x27, x12, #8
.Lbc_cont:
    sub x28, x28, #1
    b .Lbc_loop
.Lbc_ok:
    mov x0, #0
.Lbc_retx:
    ldp x27, x28, [sp, #16]
    ldp x29, x30, [sp]
    add sp, sp, #512
    ret

// az_is_url(x0=ptr,x1=len) -> w0 : scheme://rest approximation of new URL()
    .globl _az_is_url
_az_is_url:
    // scheme: alpha (alnum|+|-|.)* then "://" then >=1 char
    cbz x1, .Lur_no
    ldrb w11, [x0]
    cmp w11, #'A'
    b.lo .Lur_no
    cmp w11, #'Z'
    b.ls .Lur_s
    cmp w11, #'a'
    b.lo .Lur_no
    cmp w11, #'z'
    b.hi .Lur_no
.Lur_s:
    mov x9, #1
.Lur_scan:
    cmp x9, x1
    b.hs .Lur_no
    ldrb w11, [x0, x9]
    cmp w11, #':'
    b.eq .Lur_col
    cmp w11, #'0'
    b.lo .Lur_c
    cmp w11, #'9'
    b.ls .Lur_ok
.Lur_c:
    cmp w11, #'A'
    b.lo .Lur_c2
    cmp w11, #'Z'
    b.ls .Lur_ok
.Lur_c2:
    cmp w11, #'a'
    b.lo .Lur_c3
    cmp w11, #'z'
    b.ls .Lur_ok
.Lur_c3:
    cmp w11, #'+'
    b.eq .Lur_ok
    cmp w11, #'-'
    b.eq .Lur_ok
    cmp w11, #'.'
    b.eq .Lur_ok
    b .Lur_no
.Lur_ok:
    add x9, x9, #1
    b .Lur_scan
.Lur_col:
    // need "://" after
    add x9, x9, #1
    cmp x9, x1
    b.hs .Lur_no
    ldrb w11, [x0, x9]
    cmp w11, #'/'
    b.ne .Lur_no
    add x9, x9, #1
    cmp x9, x1
    b.hs .Lur_no
    ldrb w11, [x0, x9]
    cmp w11, #'/'
    b.ne .Lur_no
    add x9, x9, #1
    cmp x9, x1
    b.hs .Lur_no              // empty rest
    mov w0, #1
    ret
.Lur_no:
    mov w0, #0
    ret

    .section __TEXT,__const
.Lty_string:   .ascii "string"
.Lty_number:   .ascii "number"
.Lty_bigint:   .ascii "bigint"
.Lty_integer:  .ascii "integer"
.Lk_multof:    .ascii "multipleOf"
.Lv_email:     .ascii "email"
.Lv_uuid:      .ascii "uuid"
.Lv_url:       .ascii "url"
.Lv_ipv4:      .ascii "ipv4"
.Lv_ipv6:      .ascii "ipv6"
.Lv_ulid:      .ascii "ulid"
.Lv_nanoid:    .ascii "nanoid"
.Lv_cuid2:     .ascii "cuid2"
.Lv_base64:    .ascii "base64"
.Lv_hex:       .ascii "hex"
.Lv_datetime:  .ascii "datetime"
.Lv_date:      .ascii "date"
.Lv_time:      .ascii "time"
.Lv_regex:     .ascii "regex"
.Lv_startswith: .ascii "startsWith"
.Lv_endswith:  .ascii "endsWith"
.Lv_includes:  .ascii "includes"
.Lv_lowercase: .ascii "lowercase"
.Lv_uppercase: .ascii "uppercase"
.Lm_email:     .ascii "Invalid email"
.Lm_uuid:      .ascii "Invalid UUID"
.Lm_url:       .ascii "Invalid url"
.Lm_ip:        .ascii "Invalid IP address"
.Lm_ulid:      .ascii "Invalid ULID"
.Lm_nanoid:    .ascii "Invalid nanoid"
.Lm_cuid2:     .ascii "Invalid cuid2"
.Lm_base64:    .ascii "Invalid base64"
.Lm_hex:       .ascii "Invalid hex"
.Lm_datetime:  .ascii "Invalid datetime"
.Lm_date:      .ascii "Invalid date"
.Lm_time:      .ascii "Invalid time"
.Lm_regex:     .ascii "Invalid"
.Lm_sw_pre:    .ascii "Invalid input: must start with "
.Lm_ew_pre:    .ascii "Invalid input: must end with "
.Lm_inc_pre:   .ascii "Invalid input: must include "
.Lm_lc:        .ascii "Invalid input: must contain only lowercase letters"
.Lm_uc:        .ascii "Invalid input: must contain only uppercase letters"

// port.h — dual-target (Mach-O / ELF) asm portability layer.
// Assemble with `clang -x assembler-with-cpp` so these macros expand.
#ifdef __APPLE__
#ifdef AZ_COUNT
#define AZ_NAPI(n) _aznc_##n
#else
#define AZ_NAPI(n) _##n
#endif
#define AZ_RODATA .section __TEXT,__const
#define AZ_DATA   .section __DATA,__const
#define AZ_WDATA  .section __DATA,__data
.macro AZ_HIDDEN sym
	.private_extern \sym
.endm
.macro AZ_ADR reg, sym
	adrp \reg, \sym@PAGE
	add  \reg, \reg, \sym@PAGEOFF
.endm
// AZ_GUARD: write arenas live in mmap'd regions with PROT_NONE guard
// pages either side; symbols become pointer cells filled by _azn_guard_init.
#ifdef AZ_GUARD
.macro AZ_ARENA reg, sym
	adrp \reg, \sym@PAGE
	ldr  \reg, [\reg, \sym@PAGEOFF]
.endm
#else
.macro AZ_ARENA reg, sym
	adrp \reg, \sym@PAGE
	add  \reg, \reg, \sym@PAGEOFF
.endm
#endif
#else
#ifdef AZ_COUNT
#define AZ_NAPI(n) aznc_##n
#else
#define AZ_NAPI(n) n
#endif
#define AZ_RODATA .section .rodata
#define AZ_DATA   .section .data.rel.ro
#define AZ_WDATA  .section .data
.macro AZ_HIDDEN sym
	.hidden \sym
.endm
.macro AZ_ADR reg, sym
	adrp \reg, \sym
	add  \reg, \reg, :lo12:\sym
.endm
#ifdef AZ_GUARD
.macro AZ_ARENA reg, sym
	adrp \reg, \sym
	ldr  \reg, [\reg, :lo12:\sym]
.endm
#else
.macro AZ_ARENA reg, sym
	adrp \reg, \sym
	add  \reg, \reg, :lo12:\sym
.endm
#endif
#endif

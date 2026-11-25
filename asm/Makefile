# Dual-target build: Mach-O dylib on macOS, ELF .so on Linux.
UNAME  := $(shell uname -s)
ASMSRC := $(filter-out aznc.s,$(wildcard *.s))
OBJ    := $(filter-out napi.o,$(ASMSRC:.s=.o))
NOBJ   := $(OBJ) napi.o

ifeq ($(UNAME),Darwin)
OUT     := libasmzod.dylib
LDFLAGS := -shared -arch arm64
else
OUT     := libasmzod.so
# -Bsymbolic: adrp references to our own tables bind internally —
# required for ELF PIC since we use direct adrp (no GOT indirection)
LDFLAGS := -shared -Bsymbolic
endif

ASFLAGS := -x assembler-with-cpp -I. -arch arm64
ifeq ($(UNAME),Linux)
ASFLAGS := -x assembler-with-cpp -I. --target=aarch64-linux-gnu -fPIC
endif

all: $(OUT) asmzod.node

$(OUT): $(OBJ)
	clang $(LDFLAGS) -o $@ $(OBJ)

# N-API addon: same objects; napi_* symbols resolve from the host process
# at load time (dynamic_lookup on Mach-O; undefined allowed by default on ELF).
NODE := asmzod.node
ifeq ($(UNAME),Darwin)
NLDFLAGS := -shared -arch arm64 -undefined dynamic_lookup
else
NLDFLAGS := -shared -Bsymbolic
endif

$(NODE): $(NOBJ)
	clang $(NLDFLAGS) -o $@ $(NOBJ)

napi: $(NODE)

%.o: %.s port.h
	clang $(ASFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJ) napi.o $(OUT) $(NODE)

.PHONY: all clean napi

# instrumented build: every AZ_NAPI call counted (az_napicalls() -> base,count)
aznc.o: aznc.s port.h
	clang -x assembler-with-cpp -I. -arch arm64 -c -o aznc.o aznc.s
asmzod-count.node: $(patsubst %.s,%-c.o,$(ASMSRC)) aznc.o
	clang -shared -arch arm64 -undefined dynamic_lookup -o $@ $(patsubst %.s,%-c.o,$(ASMSRC)) aznc.o
%-c.o: %.s port.h
	clang -x assembler-with-cpp -DAZ_COUNT -I. -arch arm64 -c -o $@ $<

# AZ_GUARD: guard-page arenas (debug/fuzz builds)
%-g.o: %.s port.h
	clang -x assembler-with-cpp -DAZ_GUARD -I. -arch arm64 -c -o $@ $<
asmzod-guard.node: $(patsubst %.s,%-g.o,$(ASMSRC))
	clang -shared -arch arm64 -undefined dynamic_lookup -o $@ $(patsubst %.s,%-g.o,$(ASMSRC))

# ---- x86-64 port (in progress — see x86/PORT.md) ----
# assembles every ported file for x86-64 ELF: catches syntax/PIC regressions
# on the host without qemu. semantic tests run in the asmzod-x86 container.
X86SRC := $(filter-out x86/xtest.c,$(wildcard x86/*.s))
X86OBJ := $(X86SRC:.s=.xo)

x86: $(X86OBJ)
	@echo "x86-64 objects: $(X86OBJ)"

%.xo: %.s x86/portx.h
	clang -x assembler-with-cpp -Ix86 --target=x86_64-linux-gnu -fPIC -c -o $@ $<

x86-test: x86
	docker run --rm --platform linux/amd64 -v $(CURDIR)/x86:/x asmzod-x86 bash -c \
	  'mkdir -p /tmp/azx && cd /tmp/azx && cp /x/*.s /x/*.h /x/*.c . 2>/dev/null; \
	   for f in util; do clang -x assembler-with-cpp -I. -fPIC -c -o $$f.o $$f.s; done && \
	   clang -o xtest xtest.c util.o && ./xtest'

x86-clean:
	rm -f x86/*.xo

.PHONY: x86 x86-test x86-clean

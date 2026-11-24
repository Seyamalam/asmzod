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

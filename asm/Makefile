# Dual-target build: Mach-O dylib on macOS, ELF .so on Linux.
UNAME  := $(shell uname -s)
ASMSRC := $(wildcard *.s)
OBJ    := $(ASMSRC:.s=.o)

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

$(NODE): $(OBJ)
	clang $(NLDFLAGS) -o $@ $(OBJ)

napi: $(NODE)

%.o: %.s port.h
	clang $(ASFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJ) $(OUT) $(NODE)

.PHONY: clean napi

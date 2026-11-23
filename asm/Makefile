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

%.o: %.s port.h
	clang $(ASFLAGS) -c -o $@ $<

clean:
	rm -f $(OBJ) $(OUT)

.PHONY: clean

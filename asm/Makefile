ASMSRC := $(wildcard *.s)
OBJ := $(ASMSRC:.s=.o)
OUT := libasmzod.dylib

$(OUT): $(OBJ)
	clang -shared -arch arm64 -o $@ $(OBJ)

%.o: %.s
	clang -c -arch arm64 -o $@ $<

clean:
	rm -f $(OBJ) $(OUT)

.PHONY: clean

# thin alias layer over the Makefile — `just ci` etc.
default: ci
ci: ; make ci
build: ; make -C asm
test: ; bun test
portable: ; AZ_ENGINE=portable bun test
node: ; node --test node/node.test.mjs
deno: ; deno test --no-check deno/deno.test.ts
linux: ; ./docker-test.sh
bench: ; bun bench/bench.ts
doctor: ; bun scripts/doctor.ts
dump expr: ; bun scripts/dump.ts "{{expr}}"
hooks: ; ./scripts/install-hooks.sh

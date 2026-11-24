# AsmZod — local CI. No GitHub Actions; this is the whole pipeline.
.PHONY: ci build typecheck test test-portable test-node test-deno bench lint

build:
	$(MAKE) -C asm

typecheck:
	npx tsc --noEmit

test:
	bun test

test-portable:
	AZ_ENGINE=portable bun test

test-node:
	node --test node/node.test.mjs

test-deno:
	deno test --no-check deno/deno.test.ts

bench:
	bun bench/bench.ts

ci: build typecheck test test-portable
	@command -v node >/dev/null 2>&1 && $(MAKE) test-node || echo "ci: node not found, skipping"
	@command -v deno >/dev/null 2>&1 && $(MAKE) test-deno || echo "ci: deno not found, skipping"
	@./scripts/workerd.sh
	@echo "ci: ok"

# optional heavier checks
ci-linux:
	./docker-test.sh

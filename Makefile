# BUSY Web OS — dev & release tasks

PORT ?= 3000
SMOKE_PORT := 4999
TARBALL = busybar-webos-$(shell node -p "require('./package.json').version").tgz

.PHONY: help dev start typecheck pack smoke release-patch release-minor release-major clean

help: ## List available targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

dev: ## Run with auto-reload (tsx watch)
	pnpm dev

start: ## Run once, no reload
	pnpm start

typecheck: ## TypeScript check, no emit
	pnpm typecheck

pack: typecheck ## Build the npm tarball
	npm pack

smoke: pack ## Boot the packed tarball exactly like npx would, probe the API, tear down
	@rm -rf /tmp/busybar-smoke && mkdir -p /tmp/busybar-smoke
	@BUSYBAR_DATA_DIR=/tmp/busybar-smoke PORT=$(SMOKE_PORT) \
		npx --yes --package=file:./$(TARBALL) busybar-webos > /tmp/busybar-smoke/boot.log 2>&1 & \
	sleep 12; \
	status=0; \
	if curl -sf http://localhost:$(SMOKE_PORT)/api/widgets > /dev/null; then \
		echo "✅ smoke OK — packaged app boots and serves the API"; \
	else \
		echo "❌ smoke FAILED — boot log:"; cat /tmp/busybar-smoke/boot.log; status=1; \
	fi; \
	lsof -ti tcp:$(SMOKE_PORT) | xargs kill 2>/dev/null || true; \
	exit $$status

release-patch: smoke ## Bump 0.1.x, publish to npm
	npm version patch && npm publish

release-minor: smoke ## Bump 0.x.0, publish to npm
	npm version minor && npm publish

release-major: smoke ## Bump x.0.0, publish to npm
	npm version major && npm publish

clean: ## Remove packed tarballs and smoke artifacts
	rm -f busybar-webos-*.tgz
	rm -rf /tmp/busybar-smoke

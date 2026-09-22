# Base image option `dhi` — Docker Hardened Images

Verified 2026-09-13/14 by pulling and inspecting the images (`docker image inspect`, file extraction) and from docs.docker.com/dhi.

## Facts that shape the templates
| Image | Purpose | User | Shell | Notable defaults |
|---|---|---|---|---|
| `dhi.io/dotnet:8.0-sdk` | .NET build stage | root | yes | `DOTNET_ROOT=/usr/lib/dotnet`, workdir `/app`, telemetry opt-out, SDK 8.0.4xx |
| `dhi.io/aspnetcore:8.0` | .NET runtime | `65532` (`nonroot`) | **no** | `ASPNETCORE_HTTP_PORTS=8080`, `DOTNET_ROOT=/opt/dotnet`, no `ENTRYPOINT` (the Dockerfile sets `["dotnet", "<Assembly>.dll"]`) |
| `dhi.io/node:22-dev` | Node/Vite build stage | root | yes | node 22.x, npm available, workdir `/app` |
| `dhi.io/nginx:1.29` | static frontend runtime | `nginx` (uid 65532) | **no** | `ENTRYPOINT ["nginx"] CMD ["-g","daemon off;"]`, listens on **8080**, `pid /run/nginx/nginx.pid`, includes `/etc/nginx/conf.d/*.conf`, docroot `/usr/share/nginx/html`; `/run/nginx`, `/var/cache/nginx`, `/var/log/nginx`, `/etc/nginx/conf.d` are group-owned by 65532 |
- Community images live at `dhi.io/<image>:<tag>`; pulling requires `docker login dhi.io` with Docker Hub credentials (an organization access token is recommended for CI). Anonymous pulls fail with `unauthorized`.
- Runtime images are distroless: no shell, no package manager, non-root. Consequences: no `HEALTHCHECK` with `curl` (use platform probes), no `envsubst` templating (bake configuration at scaffold time), no `RUN` in the runtime stage.
- glibc based (Debian 13 "trixie" for nginx 1.29.x). Do not mix with Alpine/musl packages.
- Tag policy for slipway: pin the major.minor from `build.*_version` (`8.0`, `22`, `1.29`); CI rebuilds pick up patch updates from the registry.

## Patterns used by the stack templates
- **.NET**: restore with only the `.csproj` copied (cacheable), then `dotnet publish -c Release -p:Version -p:InformationalVersion -p:UseAppHost=false` into `/out`; copy with `--chown=65532:65532`; `USER 65532`; `ENTRYPOINT ["dotnet","<Assembly>.dll"]`. `IncludeSourceRevisionInInformationalVersion=false` in the csproj keeps the reported version equal to the tag.
- **React/Vite + nginx**: `npm ci` then `npm run build` with `VITE_APP_VERSION=$VERSION`; copy `dist` to `/usr/share/nginx/html` and a server block to `/etc/nginx/conf.d/default.conf`. Upstreams: `proxy_pass http://<upstream-app-name>;` (no URI part, so `/api/health` reaches the API unchanged) and **no `Host` override**: Container Apps routes by the `Host` header, which nginx sets to `$proxy_host` by default. A second `nginx.local.conf` targets `http://<app>:<port>` for docker compose.
- **Labels**: `org.opencontainers.image.version`, `.revision`, `.source`, `.title` on every runtime stage so `/slipway:verify` can compare the running image to the tag and commit.
- **Ports**: everything listens on the app's `port` (8080 by default) as non-root; never bind < 1024.

## Local verification recipe (what `/slipway:dockerize` runs)
```
docker build --build-arg VERSION=$V --build-arg COMMIT=$C -t <project>/<app>:$V <path>
docker run -d --rm -p 8080:8080 --name t <project>/<app>:$V; curl -fsS localhost:8080/health
docker inspect -f '{{.Config.User}}' <image>; docker run --rm --entrypoint /bin/sh <image> -c true   # must fail
VERSION=$V docker compose up -d --build; curl -fsS localhost:8081/api/health; docker compose down
```
Reference results on `adlc-demo` (2026-09-14): api ≈ 60 MB, web ≈ 30 MB, both non-root, web → api proxy answered with the API's version.

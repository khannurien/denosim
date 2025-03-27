FROM denoland/deno:bin-2.2.5 AS deno
FROM mcr.microsoft.com/devcontainers/typescript-node:22
COPY --from=deno /deno /usr/local/bin/deno

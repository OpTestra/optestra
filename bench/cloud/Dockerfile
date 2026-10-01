# The cost-run image (COST-0): the engine, Chromium and the bench fixtures, on
# Node 24 and the Playwright base image. Generic: no project, no account, no key
# (the API key, when used, is mounted at run time from Secret Manager).
# Built remotely by Cloud Build (bench/cloud/cloudbuild.yaml) from the repository root.

# The Playwright version must match the engine's (packages/browser) so its browsers are the ones it drives.
ARG PLAYWRIGHT_VERSION=1.63.0
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

# Node 24 from nodejs.org, checked against its published SHA-256 (the image ships an older Node).
ARG NODE_VERSION=24.21.0
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) n=x64 ;; arm64) n=arm64 ;; *) echo "unsupported $arch" >&2; exit 1 ;; esac \
 && file="node-v${NODE_VERSION}-linux-${n}.tar.xz" \
 && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${file}" \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" | grep " ${file}\$" | sha256sum -c - \
 && tar -xJf "${file}" -C /usr/local --strip-components=1 --no-same-owner \
 && rm "${file}" \
 && node --version

# Browsers come with the base image; never download them again.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    CI=1

WORKDIR /app
COPY --chown=pwuser:pwuser . .
USER pwuser
RUN corepack enable --install-directory /home/pwuser/.local/bin \
 && export PATH="/home/pwuser/.local/bin:$PATH" \
 && pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm store prune
ENV PATH="/home/pwuser/.local/bin:${PATH}"

# One task = one slice (see entry.ts for the environment it reads).
ENTRYPOINT ["node", "bench/cloud/entry.ts"]

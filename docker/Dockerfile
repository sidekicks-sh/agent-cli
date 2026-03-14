FROM oven/bun:1.3 AS builder

WORKDIR /build

COPY package.json bun.lock tsconfig.json eslint.config.js ./
COPY apps ./apps
COPY src ./src

RUN bun install --frozen-lockfile \
  && bun run build

FROM debian:trixie-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive

ENV LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    HOME=/home/sidekick \
    SIDEKICK_HOME=/opt/sidekick \
    SIDEKICK_REPOS_DIR=/work/repos \
    SIDEKICK_PID_FILE=/var/run/sidekick/sidekick.pid \
    SIDEKICK_LOG_FILE=/var/log/sidekick/sidekick.log \
    SIDEKICK_AGENT=custom \
    XDG_CONFIG_HOME=/home/sidekick/.config \
    GH_CONFIG_DIR=/home/sidekick/.config/gh \
    CODEX_HOME=/home/sidekick/.codex

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    gh \
    git \
    jq \
    nodejs \
    npm \
    openssh-client \
    procps \
    tini \
  && npm install -g npm@latest @openai/codex @anthropic-ai/claude-code opencode-ai \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --home-dir /home/sidekick --shell /bin/bash sidekick \
  && mkdir -p \
    "${SIDEKICK_HOME}" \
    "${SIDEKICK_REPOS_DIR}" \
    /var/run/sidekick \
    /var/log/sidekick \
    /home/sidekick/.config/gh \
    /home/sidekick/.codex \
    /home/sidekick/.ssh \
  && chown -R sidekick:sidekick \
    /home/sidekick \
    "${SIDEKICK_HOME}" \
    "${SIDEKICK_REPOS_DIR}" \
    /var/run/sidekick \
    /var/log/sidekick

COPY --from=builder /build/dist/sidekick /opt/sidekick/sidekick
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN chmod +x /opt/sidekick/sidekick /usr/local/bin/entrypoint.sh

WORKDIR /work
USER sidekick

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/opt/sidekick/sidekick", "status"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["start"]

# tmux built from source: the Code tab talks to a tmux server running on the HOST, and tmux client and server must be the same version (TMUX_VERSION = the host's `tmux -V`).
FROM node:24-slim AS tmux
ARG TMUX_VERSION=3.6
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl build-essential bison pkg-config libevent-dev libncurses-dev \
    && curl -fsSL https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz | tar xz -C /tmp \
    && cd /tmp/tmux-${TMUX_VERSION} && ./configure --prefix=/opt/tmux && make -j4 && make install

FROM node:24-slim
# claude = Claude Code CLI (the "brain", run headless with all tools disabled); poppler/unzip let the file indexer read PDF and DOCX.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils ffmpeg unzip ca-certificates git libevent-core-2.1-7 libncurses6 \
    && rm -rf /var/lib/apt/lists/* && npm install -g @anthropic-ai/claude-code && npm cache clean --force
COPY --from=tmux /opt/tmux/bin/tmux /usr/local/bin/tmux
ENV NODE_ENV=production ASSISTANT_DATA=/data HOME=/home/node
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data /workspace /home/node/.claude && chown -R node:node /data /workspace /home/node
USER node
VOLUME ["/data", "/home/node/.claude", "/workspace"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]

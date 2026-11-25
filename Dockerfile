FROM node:24-slim
# claude = Claude Code CLI (the "brain", run headless with all tools disabled); poppler/unzip let the file indexer read PDF and DOCX.
RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* && npm install -g @anthropic-ai/claude-code && npm cache clean --force
ENV NODE_ENV=production ASSISTANT_DATA=/data HOME=/home/node
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /data /home/node/.claude && chown -R node:node /data /home/node
USER node
VOLUME ["/data", "/home/node/.claude"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/main.ts"]

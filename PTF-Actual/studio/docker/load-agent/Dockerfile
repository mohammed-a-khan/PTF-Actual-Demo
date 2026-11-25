# A load generator for CS Test Studio: `cs-test-studio agent` in a container.
#   docker build -t cs-load-agent --build-arg STUDIO_TGZ=cs-test-studio.tgz docker/load-agent
#   docker run -d -p 4720:4720 -e CS_AGENT_TOKEN=<a long secret> -e ZONE=eu-west cs-load-agent
# Copy the Studio's package (npm pack) next to this file first. The token is the one the scenario's
# generator entry refers to ({env:NAME} / {config:KEY} on the Studio side). For browser users, use the
# Playwright image as the base instead (mcr.microsoft.com/playwright:<version>-jammy).
FROM node:22-bookworm-slim
ARG STUDIO_TGZ=cs-test-studio.tgz
ENV NODE_ENV=production ZONE=""
RUN useradd --create-home --uid 10001 loadgen
COPY ${STUDIO_TGZ} /tmp/studio.tgz
RUN npm install --global --omit=dev /tmp/studio.tgz && rm /tmp/studio.tgz && npm cache clean --force
USER loadgen
WORKDIR /home/loadgen
EXPOSE 4720
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "require('http').get({host:'127.0.0.1',port:4720,path:'/health',headers:{authorization:'Bearer '+process.env.CS_AGENT_TOKEN}},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["sh", "-c", "exec cs-test-studio agent --host 0.0.0.0 --port 4720 ${ZONE:+--zone \"$ZONE\"}"]

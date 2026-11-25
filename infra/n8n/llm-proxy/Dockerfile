# OpenAI-compatible shim in front of OpenCode Go. No dependencies, no build step.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=4000

WORKDIR /app
COPY proxy.mjs ./
RUN chown -R node:node /app

USER node
EXPOSE 4000

CMD ["node", "proxy.mjs"]

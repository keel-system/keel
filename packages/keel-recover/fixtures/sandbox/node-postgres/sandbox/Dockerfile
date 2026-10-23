# Paso 0c: build del legacy con la cadena de su CI (node 20.18.0); el código entra por COPY, nunca se modifica
FROM docker.io/library/node:20.18.0-alpine3.20@sha256:a1d39fe127e43881c6770abf2f0843c955607fb56eb9b45bf6f103c992c5442a AS build
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

FROM docker.io/library/node:20.18.0-alpine3.20@sha256:a1d39fe127e43881c6770abf2f0843c955607fb56eb9b45bf6f103c992c5442a AS run
COPY --from=build /app /app
WORKDIR /app
EXPOSE 4000
ENTRYPOINT ["node", "src/server.js"]

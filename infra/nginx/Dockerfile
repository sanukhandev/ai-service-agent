# Angular is compiled to static assets and served by the ONLY public ingress.
FROM node:22-alpine AS admin-builder
WORKDIR /admin
COPY apps/admin/package*.json ./
RUN npm install --no-audit --no-fund
COPY apps/admin/ ./
RUN npm run build

FROM nginx:stable-alpine
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=admin-builder /admin/dist/admin/browser/ /usr/share/nginx/html/admin/
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

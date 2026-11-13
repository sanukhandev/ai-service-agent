# POC single public ingress. No Angular/admin build required.
FROM nginx:stable-alpine
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

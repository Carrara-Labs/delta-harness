import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("how-it-works", "routes/how-it-works.tsx"),
  route("index.html", "routes/index-redirect.ts"),
  route("healthz", "routes/healthz.ts"),
  route("*", "routes/not-found.tsx"),
] satisfies RouteConfig;

import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

function serveGeneratedDocs(): Plugin {
  return {
    name: "delta-generated-docs-directory-index",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url) return next();

        const url = new URL(request.url, "http://localhost");
        if (url.pathname === "/docs") {
          response.statusCode = 308;
          response.setHeader("Location", `/docs/${url.search}`);
          response.end();
          return;
        }

        if (url.pathname === "/docs/") {
          request.url = `/docs/index.html${url.search}`;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [serveGeneratedDocs(), tailwindcss(), reactRouter()],
  resolve: {
    tsconfigPaths: true,
  },
});

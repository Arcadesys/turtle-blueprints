import { defineConfig, type Plugin } from "vite";

/** The API lives in server/api.ts and is loaded through Vite, so it can import the TypeScript workspace packages. */
function blueprintApi(): Plugin {
  return {
    name: "blueprint-api",
    configureServer(server) {
      const api = () => server.ssrLoadModule("/server/api.ts") as Promise<typeof import("./server/api")>;
      server.middlewares.use("/mc", (req, res, next) => { void api().then((m) => m.serveTexture(req, res, next)); });
      server.middlewares.use("/api", (req, res, next) => { void api().then((m) => m.serveApi(req, res, next)); });
    },
  };
}

export default defineConfig({ plugins: [blueprintApi()], server: { port: 5173 } });

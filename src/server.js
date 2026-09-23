/**
 * Entry point. Binds the port the host gives us.
 */
import { createApp } from "./app.js";

const port = Number(process.env.PORT ?? 8080);

createApp().listen(port, () => {
  console.log(`empaz-api listening on :${port}`);
});

import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "../app/fonts.css";
import "../app/globals.css";
import { App } from "./app";
import { Providers } from "@/app/providers";

const root = document.querySelector("#root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <BrowserRouter>
    <Providers>
      <App />
      <div
        id="sr-announcer"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      />
    </Providers>
  </BrowserRouter>,
);

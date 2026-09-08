import { createRoot } from "react-dom/client";
import "./brand/tokens.css";
import "./styles/fonts.css";
import "./styles/console.css";
import { App } from "./app.js";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

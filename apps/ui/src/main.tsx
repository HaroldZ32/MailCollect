import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "dhtmlx-gantt/codebase/dhtmlxgantt.css";
import "./styles/tokens.css";
import "./styles/global.css";
import { App } from "./App";

const container = document.getElementById("root");
if (container === null) throw new Error("index.html 缺少 #root 挂载点");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { I18nProvider } from "./I18nProvider";
import { PolicyProvider } from "./PolicyProvider";
import { ClipboardProvider } from "./ClipboardProvider";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <PolicyProvider>
        <ClipboardProvider>
          <App />
        </ClipboardProvider>
      </PolicyProvider>
    </I18nProvider>
  </React.StrictMode>
);

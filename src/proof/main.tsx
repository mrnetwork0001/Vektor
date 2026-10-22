import React from "react";
import ReactDOM from "react-dom/client";
import "../styles/index.css";
import "../styles/vektor.css";
import "./proof.css";
import { ProofPage } from "./ProofPage";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ProofPage />
  </React.StrictMode>
);

import React from 'react';
import { createRoot } from 'react-dom/client';
import EndpointConstrainedNoiseApp from './EndpointConstrainedNoiseApp';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <EndpointConstrainedNoiseApp />
  </React.StrictMode>
);

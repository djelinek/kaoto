import '@patternfly/react-core/dist/styles/base.css'; // This import needs to be first

import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { router } from './router';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  /*
   * <React.StrictMode>
   * </React.StrictMode>,
   */

  <RouterProvider router={router} />,
);
// Fork test of the CI job selection: a change in the UI library runs only the VS Code smoke groups.

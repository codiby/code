/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './src/App';
import ShareApp from './src/ShareApp';
import { registerPushBackgroundHandlers } from './src/push';
import { name as appName } from './app.json';

// Before any component: Android hands pushes and notification buttons to a
// headless task when the app isn't running, and it needs these handlers.
registerPushBackgroundHandlers();

AppRegistry.registerComponent(appName, () => App);

AppRegistry.registerComponent('CodibyShare', () => ShareApp);

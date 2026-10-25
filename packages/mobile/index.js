/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './src/App';
import ShareApp from './src/ShareApp';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

AppRegistry.registerComponent('CodibyShare', () => ShareApp);

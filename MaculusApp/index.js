import { AppRegistry } from 'react-native';
import LegacyApp from './App';
import MaculusNextApp from './src/next/MaculusNextApp';
import { name as appName } from './app.json';

// MaculusNext is the new default runtime. The prototype remains registered as
// a separate entry so it can be compared during migration without sharing
// safety state or scene memory with the new application.
AppRegistry.registerComponent(appName, () => MaculusNextApp);
AppRegistry.registerComponent(`${appName}Legacy`, () => LegacyApp);

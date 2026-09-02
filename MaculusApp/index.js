import { AppRegistry } from 'react-native';
import { initExecutorch } from 'react-native-executorch';
import { BareResourceFetcher } from 'react-native-executorch-bare-resource-fetcher';
import LegacyApp from './App';
import MaculusNextApp from './src/next/MaculusNextApp';
import { whisperCommandService } from './src/services/WhisperCommandService';
import { name as appName } from './app.json';

// Bare React Native apps provide their own persistent model downloader.
// Initialize it before any ExecuTorch module is created.
initExecutorch({resourceFetcher: BareResourceFetcher});
whisperCommandService.initialize();

// MaculusNext is the new default runtime. The prototype remains registered as
// a separate entry so it can be compared during migration without sharing
// safety state or scene memory with the new application.
AppRegistry.registerComponent(appName, () => MaculusNextApp);
AppRegistry.registerComponent(`${appName}Legacy`, () => LegacyApp);

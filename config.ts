export const config = {
  databaseURI: 'mongodb://localhost:27017/nexi',
  appId: 'myAppId',
  masterKey: 'myMasterKey',
  serverURL: 'http://localhost:1337/parse',
  cloud: './cloud/main.js',
  allowClientClassCreation: true,
  maintenanceKey: 'default-maintenance-key', // required for TypeScript typing   


};

module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      ['@babel/plugin-proposal-decorators', { version: 'legacy' }],
      ['@babel/plugin-proposal-class-properties', { loose: true }],
    ],
  };
};

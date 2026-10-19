module.exports = {
  extends: ['next/core-web-vitals'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "JSXExpressionContainer > JSXElement > JSXAttribute[name.name='dangerouslySetInnerHTML']",
        message: 'dangerouslySetInnerHTML is forbidden.',
      },
    ],
  },
};

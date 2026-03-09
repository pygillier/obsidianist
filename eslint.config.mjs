import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
	{ ignores: ["node_modules/", "main.js"] },
	js.configs.recommended,
	{
		files: ["**/*.ts"],
		languageOptions: {
			parser: tsParser,
			sourceType: "module",
			parserOptions: {
				project: "./tsconfig.json",
			},
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
		},
		rules: {
			...tsPlugin.configs["recommended"].rules,
			"no-undef": "off",
			"no-unused-vars": "off",
			"@typescript-eslint/no-unused-vars": ["error", { args: "none" }],
			"@typescript-eslint/ban-ts-comment": "off",
			"no-prototype-builtins": "off",
			"@typescript-eslint/no-empty-function": "off",
		},
	},
];

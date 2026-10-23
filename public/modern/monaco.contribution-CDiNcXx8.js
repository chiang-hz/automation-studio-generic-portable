import { m as e } from "./editor.api-Bun3BN_F.js";
//#region node_modules/monaco-editor/esm/vs/language/typescript/monaco.contribution.js
var t = Object.defineProperty, n = Object.getOwnPropertyDescriptor, r = Object.getOwnPropertyNames, i = Object.prototype.hasOwnProperty, a = (e, a, o, s) => {
	if (a && typeof a == "object" || typeof a == "function") for (let c of r(a)) !i.call(e, c) && c !== o && t(e, c, {
		get: () => a[c],
		enumerable: !(s = n(a, c)) || s.enumerable
	});
	return e;
}, o = (e, t, n) => (a(e, t, "default"), n && a(n, t, "default")), s = "5.4.5", c = {};
o(c, e);
var l = /* @__PURE__ */ ((e) => (e[e.None = 0] = "None", e[e.CommonJS = 1] = "CommonJS", e[e.AMD = 2] = "AMD", e[e.UMD = 3] = "UMD", e[e.System = 4] = "System", e[e.ES2015 = 5] = "ES2015", e[e.ESNext = 99] = "ESNext", e))(l || {}), u = /* @__PURE__ */ ((e) => (e[e.None = 0] = "None", e[e.Preserve = 1] = "Preserve", e[e.React = 2] = "React", e[e.ReactNative = 3] = "ReactNative", e[e.ReactJSX = 4] = "ReactJSX", e[e.ReactJSXDev = 5] = "ReactJSXDev", e))(u || {}), d = /* @__PURE__ */ ((e) => (e[e.CarriageReturnLineFeed = 0] = "CarriageReturnLineFeed", e[e.LineFeed = 1] = "LineFeed", e))(d || {}), f = /* @__PURE__ */ ((e) => (e[e.ES3 = 0] = "ES3", e[e.ES5 = 1] = "ES5", e[e.ES2015 = 2] = "ES2015", e[e.ES2016 = 3] = "ES2016", e[e.ES2017 = 4] = "ES2017", e[e.ES2018 = 5] = "ES2018", e[e.ES2019 = 6] = "ES2019", e[e.ES2020 = 7] = "ES2020", e[e.ESNext = 99] = "ESNext", e[e.JSON = 100] = "JSON", e[e.Latest = 99] = "Latest", e))(f || {}), p = /* @__PURE__ */ ((e) => (e[e.Classic = 1] = "Classic", e[e.NodeJs = 2] = "NodeJs", e))(p || {}), m = class {
	constructor(e, t, n, r, i) {
		this._onDidChange = new c.Emitter(), this._onDidExtraLibsChange = new c.Emitter(), this._extraLibs = /* @__PURE__ */ Object.create(null), this._removedExtraLibs = /* @__PURE__ */ Object.create(null), this._eagerModelSync = !1, this.setCompilerOptions(e), this.setDiagnosticsOptions(t), this.setWorkerOptions(n), this.setInlayHintsOptions(r), this.setModeConfiguration(i), this._onDidExtraLibsChangeTimeout = -1;
	}
	get onDidChange() {
		return this._onDidChange.event;
	}
	get onDidExtraLibsChange() {
		return this._onDidExtraLibsChange.event;
	}
	get modeConfiguration() {
		return this._modeConfiguration;
	}
	get workerOptions() {
		return this._workerOptions;
	}
	get inlayHintsOptions() {
		return this._inlayHintsOptions;
	}
	getExtraLibs() {
		return this._extraLibs;
	}
	addExtraLib(e, t) {
		let n;
		if (n = t === void 0 ? `ts:extralib-${Math.random().toString(36).substring(2, 15)}` : t, this._extraLibs[n] && this._extraLibs[n].content === e) return { dispose: () => {} };
		let r = 1;
		return this._removedExtraLibs[n] && (r = this._removedExtraLibs[n] + 1), this._extraLibs[n] && (r = this._extraLibs[n].version + 1), this._extraLibs[n] = {
			content: e,
			version: r
		}, this._fireOnDidExtraLibsChangeSoon(), { dispose: () => {
			let e = this._extraLibs[n];
			e && e.version === r && (delete this._extraLibs[n], this._removedExtraLibs[n] = r, this._fireOnDidExtraLibsChangeSoon());
		} };
	}
	setExtraLibs(e) {
		for (let e in this._extraLibs) this._removedExtraLibs[e] = this._extraLibs[e].version;
		if (this._extraLibs = /* @__PURE__ */ Object.create(null), e && e.length > 0) for (let t of e) {
			let e = t.filePath || `ts:extralib-${Math.random().toString(36).substring(2, 15)}`, n = t.content, r = 1;
			this._removedExtraLibs[e] && (r = this._removedExtraLibs[e] + 1), this._extraLibs[e] = {
				content: n,
				version: r
			};
		}
		this._fireOnDidExtraLibsChangeSoon();
	}
	_fireOnDidExtraLibsChangeSoon() {
		this._onDidExtraLibsChangeTimeout === -1 && (this._onDidExtraLibsChangeTimeout = window.setTimeout(() => {
			this._onDidExtraLibsChangeTimeout = -1, this._onDidExtraLibsChange.fire(void 0);
		}, 0));
	}
	getCompilerOptions() {
		return this._compilerOptions;
	}
	setCompilerOptions(e) {
		this._compilerOptions = e || /* @__PURE__ */ Object.create(null), this._onDidChange.fire(void 0);
	}
	getDiagnosticsOptions() {
		return this._diagnosticsOptions;
	}
	setDiagnosticsOptions(e) {
		this._diagnosticsOptions = e || /* @__PURE__ */ Object.create(null), this._onDidChange.fire(void 0);
	}
	setWorkerOptions(e) {
		this._workerOptions = e || /* @__PURE__ */ Object.create(null), this._onDidChange.fire(void 0);
	}
	setInlayHintsOptions(e) {
		this._inlayHintsOptions = e || /* @__PURE__ */ Object.create(null), this._onDidChange.fire(void 0);
	}
	setMaximumWorkerIdleTime(e) {}
	setEagerModelSync(e) {
		this._eagerModelSync = e;
	}
	getEagerModelSync() {
		return this._eagerModelSync;
	}
	setModeConfiguration(e) {
		this._modeConfiguration = e || /* @__PURE__ */ Object.create(null), this._onDidChange.fire(void 0);
	}
}, h = s, g = {
	completionItems: !0,
	hovers: !0,
	documentSymbols: !0,
	definitions: !0,
	references: !0,
	documentHighlights: !0,
	rename: !0,
	diagnostics: !0,
	documentRangeFormattingEdits: !0,
	signatureHelp: !0,
	onTypeFormattingEdits: !0,
	codeActions: !0,
	inlayHints: !0
}, _ = new m({
	allowNonTsExtensions: !0,
	target: 99
}, {
	noSemanticValidation: !1,
	noSyntaxValidation: !1,
	onlyVisible: !1
}, {}, {}, g), v = new m({
	allowNonTsExtensions: !0,
	allowJs: !0,
	target: 99
}, {
	noSemanticValidation: !0,
	noSyntaxValidation: !1,
	onlyVisible: !1
}, {}, {}, g), y = () => x().then((e) => e.getTypeScriptWorker()), b = () => x().then((e) => e.getJavaScriptWorker());
c.languages.typescript = {
	ModuleKind: l,
	JsxEmit: u,
	NewLineKind: d,
	ScriptTarget: f,
	ModuleResolutionKind: p,
	typescriptVersion: h,
	typescriptDefaults: _,
	javascriptDefaults: v,
	getTypeScriptWorker: y,
	getJavaScriptWorker: b
};
function x() {
	return import("./tsMode-DBjnKcYJ.js");
}
c.languages.onLanguage("typescript", () => x().then((e) => e.setupTypeScript(_))), c.languages.onLanguage("javascript", () => x().then((e) => e.setupJavaScript(v)));
//#endregion
export { _ as t };

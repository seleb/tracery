/**
 * @author Kate
 */

type Settings = {
	raw?: string;
	type?: number;
};

class ArrayWithErrors<T> extends Array<T> {
	errors: string[];
}

class TraceryNode {
	errors: string[];
	expansionErrors: string[];
	grammar: TraceryGrammar;
	parent: TraceryNode | null;
	depth: number;
	childIndex: number;
	isExpanded: boolean;
	children: TraceryNode[];
	finishedText?: string;
	childRule: string;
	raw: string | undefined;
	type: number | undefined;
	symbol: string;
	modifiers: string[];
	preactions: TraceryNodeAction[];
	postactions: TraceryNodeAction[];
	action?: TraceryNodeAction;
	constructor(parent: TraceryNode | TraceryGrammar | null, childIndex: number, settings: Settings) {
		this.errors = [];

		// No input? Add an error, but continue anyways
		if (settings.raw === undefined) {
			this.errors.push('Empty input for node');
			settings.raw = '';
		}

		// If the root node of an expansion, it will have the grammar passed as the 'parent'
		//  set the grammar from the 'parent', and set all other values for a root node
		if (parent instanceof tracery.Grammar) {
			this.grammar = parent;
			this.parent = null;
			this.depth = 0;
			this.childIndex = 0;
		} else {
			this.grammar = parent.grammar;
			this.parent = parent;
			this.depth = parent.depth + 1;
			this.childIndex = childIndex;
		}

		this.raw = settings.raw;
		this.type = settings.type;
		this.isExpanded = false;

		if (!this.grammar) {
			this.errors.push('No grammar specified for this node ' + this);
		}
	}
	toString() {
		return "Node('" + this.raw + "' " + this.type + ' d:' + this.depth + ')';
	}
	expandChildren(childRule: string, preventRecursion: boolean) {
		this.children = [];
		this.finishedText = '';

		// Set the rule for making children,
		// and expand it into section
		this.childRule = childRule;
		if (this.childRule !== undefined) {
			var sections = tracery.parse(childRule);

			// Add errors to this
			if (sections.errors.length > 0) {
				this.errors = this.errors.concat(sections.errors);
			}

			for (var i = 0; i < sections.length; i++) {
				this.children[i] = new TraceryNode(this, i, sections[i]);
				if (!preventRecursion) this.children[i].expand(preventRecursion);

				// Add in the finished text
				this.finishedText += this.children[i].finishedText;
			}
		} else {
			// In normal operation, this shouldn't ever happen
			this.errors.push("No child rule provided, can't expand children");
		}
	}
	expand(preventRecursion?: boolean) {
		if (!this.isExpanded) {
			this.isExpanded = true;

			this.expansionErrors = [];

			// Types of nodes
			// -1: raw, needs parsing
			//  0: Plaintext
			//  1: Tag ("#symbol.mod.mod2.mod3#" or "#[pushTarget:pushRule]symbol.mod")
			//  2: Action ("[pushTarget:pushRule], [pushTarget:POP]", more in the future)

			switch (this.type) {
				// Raw rule
				case -1:
					this.expandChildren(this.raw, preventRecursion);
					break;

				// plaintext, do nothing but copy text into finished text
				case 0:
					this.finishedText = this.raw;
					break;

				// Tag
				case 1:
					// Parse to find any actions, and figure out what the symbol is
					this.preactions = [];
					this.postactions = [];

					var parsed = tracery.parseTag(this.raw);

					// Break into symbol actions and modifiers
					this.symbol = parsed.symbol;
					this.modifiers = parsed.modifiers;

					// Create all the preactions from the raw syntax
					for (var i = 0; i < parsed.preactions.length; i++) {
						this.preactions[i] = new TraceryNodeAction(this, parsed.preactions[i].raw);
					}
					for (var i = 0; i < parsed.postactions.length; i++) {
						//   this.postactions[i] = new NodeAction(this, parsed.postactions[i].raw);
					}

					// Make undo actions for all preactions (pops for each push)
					for (var i = 0; i < this.preactions.length; i++) {
						if (this.preactions[i].type === 0) this.postactions.push(this.preactions[i].createUndo());
					}

					// Activate all the preactions
					for (var i = 0; i < this.preactions.length; i++) {
						this.preactions[i].activate();
					}

					this.finishedText = this.raw;

					// Expand (passing the node, this allows tracking of recursion depth)

					var selectedRule = this.grammar.selectRule(this.symbol, this, this.errors);

					this.expandChildren(selectedRule, preventRecursion);

					// Apply modifiers
					// TODO: Update parse function to not trigger on hashtags within parenthesis within tags,
					//   so that modifier parameters can contain tags "#story.replace(#protagonist#, #newCharacter#)#"
					for (var i = 0; i < this.modifiers.length; i++) {
						var modName = this.modifiers[i];
						var modParams = new Array<string>();
						if (modName.indexOf('(') > 0) {
							var regExp = /\(([^)]+)\)/;

							// Todo: ignore any escaped commas.  For now, commas always split
							var results = regExp.exec(this.modifiers[i]);
							if (!results || results.length < 2) {
							} else {
								var modParams = results[1].split(',');
								modName = this.modifiers[i].substring(0, modName.indexOf('('));
							}
						}

						var mod = this.grammar.modifiers[modName];

						// Missing modifier?
						if (!mod) {
							this.errors.push('Missing modifier ' + modName);
							this.finishedText += '((.' + modName + '))';
						} else {
							this.finishedText = mod(this.finishedText, modParams);
						}
					}

					// Perform post-actions
					for (var i = 0; i < this.postactions.length; i++) {
						this.postactions[i].activate();
					}
					break;
				case 2:
					// Just a bare action?  Expand it!
					this.action = new TraceryNodeAction(this, this.raw);
					this.action.activate();

					// No visible text for an action
					// TODO: some visible text for if there is a failure to perform the action?
					this.finishedText = '';
					break;
			}
		} else {
			//console.warn("Already expanded " + this);
		}
	}
	clearEscapeChars() {
		this.finishedText = this.finishedText
			.replace(/\\\\/g, 'DOUBLEBACKSLASH')
			.replace(/\\/g, '')
			.replace(/DOUBLEBACKSLASH/g, '\\');
	}
}

class TraceryNodeAction {
	node: TraceryNode;
	type: 0 | 1 | 2;
	target: string;
	rule: string;
	ruleSections: string[];
	finishedRules: string[];
	constructor(node: TraceryNode, raw: string) {
		/*
			 if (!node)
			 console.warn("No node for NodeAction");
			 if (!raw)
			 console.warn("No raw commands for NodeAction");
			 */

		this.node = node;

		var sections = raw.split(':');
		this.target = sections[0];

		// No colon? A function!
		if (sections.length === 1) {
			this.type = 2;
		}

		// Colon? It's either a push or a pop
		else {
			this.rule = sections[1];
			if (this.rule === 'POP') {
				this.type = 1;
			} else {
				this.type = 0;
			}
		}
	}
	createUndo() {
		if (this.type === 0) {
			return new TraceryNodeAction(this.node, this.target + ':POP');
		}
		// TODO Not sure how to make Undo actions for functions or POPs
		return null;
	}
	activate() {
		var grammar = this.node.grammar;
		switch (this.type) {
			case 0:
				// split into sections (the way to denote an array of rules)
				this.ruleSections = this.rule.split(',');
				this.finishedRules = [];
				for (var i = 0; i < this.ruleSections.length; i++) {
					var n = new TraceryNode(grammar, 0, {
						type: -1,
						raw: this.ruleSections[i],
					});

					n.expand();

					this.finishedRules.push(n.finishedText);
				}

				// TODO: escape commas properly
				grammar.pushRules(this.target, this.finishedRules, !!this);
				break;
			case 1:
				grammar.popRules(this.target);
				break;
			case 2:
				grammar.flatten(this.target, true);
				break;
		}
	}
	toText() {
		switch (this.type) {
			case 0:
				return this.target + ':' + this.rule;
			case 1:
				return this.target + ':POP';
			case 2:
				return '((some function))';
			default:
				return '((Unknown Action))';
		}
	}
}

class TraceryRuleSet {
	falloff: number;
	defaultRules: string[];
	defaultUses?: number[];
	conditionalRule?: string;
	conditionalValues?: TraceryRuleSet[];
	shuffledDeck?: number[];
	constructor(public grammar: TraceryGrammar, public raw: string | string[]) {
		this.falloff = 1;

		if (Array.isArray(raw)) {
			this.defaultRules = raw;
		} else if (typeof raw === 'string') {
			this.defaultRules = [raw];
		} else if (raw === 'object') {
			// TODO: support for conditional and hierarchical rule sets
		}
	}
	selectRule(errors?: string[]) {
		// console.log("Get rule", this.raw);
		// Is there a conditional?
		if (this.conditionalRule) {
			var value = this.grammar.expand(this.conditionalRule, true);
			// does this value match any of the conditionals?
			if (this.conditionalValues[value.toString()]) {
				var v = this.conditionalValues[value.toString()].selectRule(errors);
				if (v !== null && v !== undefined) return v;
			}
			// No returned value?
		}

		if (this.defaultRules !== undefined) {
			var index = Math.floor(Math.pow(Math.random(), this.falloff) * this.defaultRules.length);

			if (!this.defaultUses) this.defaultUses = [];
			this.defaultUses[index] = ++this.defaultUses[index] || 1;
			return this.defaultRules[index];
		}

		errors.push('No default rules defined for ' + this);
		return null;
	}
	clearState() {
		if (this.defaultUses) {
			this.defaultUses = [];
		}
	}
}

function fyshuffle<T>(array: T[]) {
	var currentIndex = array.length,
		temporaryValue,
		randomIndex;

	// While there remain elements to shuffle...
	while (0 !== currentIndex) {
		// Pick a remaining element...
		randomIndex = Math.floor(Math.random() * currentIndex);
		currentIndex -= 1;

		// And swap it with the current element.
		temporaryValue = array[currentIndex];
		array[currentIndex] = array[randomIndex];
		array[randomIndex] = temporaryValue;
	}

	return array;
}

class TracerySymbol {
	baseRules: TraceryRuleSet;
	stack?: TraceryRuleSet[];
	uses?: Array<{
		node?: TraceryNode;
	}>;
	isDynamic?: boolean;
	constructor(public grammar: TraceryGrammar, public key: string, public rawRules: ConstructorParameters<typeof TraceryRuleSet>[1]) {
		// Symbols can be made with a single value, and array, or array of objects of (conditions/values)
		this.baseRules = new TraceryRuleSet(this.grammar, rawRules);
		this.clearState();
	}
	clearState() {
		// Clear the stack and clear all ruleset usages
		this.stack = [this.baseRules];

		this.uses = [];
		this.baseRules.clearState();
	}

	pushRules(rawRules: ConstructorParameters<typeof TraceryRuleSet>[1]) {
		var rules = new TraceryRuleSet(this.grammar, rawRules);
		this.stack.push(rules);
	}

	popRules() {
		this.stack.pop();
	}

	selectRule(node?: TraceryNode, errors?: string[]) {
		this.uses.push({
			node: node,
		});

		if (this.stack.length === 0) {
			errors.push("The rule stack for '" + this.key + "' is empty, too many pops?");
			return '((' + this.key + '))';
		}

		return this.stack[this.stack.length - 1].selectRule();
	}

	getActiveRules() {
		if (this.stack.length === 0) {
			return null;
		}
		return this.stack[this.stack.length - 1].selectRule();
	}

	rulesToJSON() {
		return JSON.stringify(this.rawRules);
	}
}

type Modifiers = Record<string, (s: string, params: string[]) => string>;

class TraceryGrammar {
	modifiers: Modifiers;
	symbols: Partial<Record<string, TracerySymbol>>;
	raw: Record<string, string | string[]>;
	subgrammars: TraceryGrammar[];
	errors?: string[];
	constructor(raw: Record<string, string | string[]>) {
		this.modifiers = {};
		this.loadFromRawObj(raw);
	}

	clearState() {
		var keys = Object.keys(this.symbols);
		for (var i = 0; i < keys.length; i++) {
			this.symbols[keys[i]].clearState();
		}
	}

	addModifiers(mods: Modifiers) {
		// copy over the base modifiers
		for (var key in mods) {
			if (mods.hasOwnProperty(key)) {
				this.modifiers[key] = mods[key];
			}
		}
	}

	loadFromRawObj(raw: Record<string, string | string[]>) {
		this.raw = raw;
		this.symbols = {};
		this.subgrammars = [];

		if (this.raw) {
			// Add all rules to the grammar
			for (var key in this.raw) {
				if (this.raw.hasOwnProperty(key)) {
					this.symbols[key] = new TracerySymbol(this, key, this.raw[key]);
				}
			}
		}
	}

	createRoot(rule: string) {
		// Create a node and subnodes
		var root = new TraceryNode(this, 0, {
			type: -1,
			raw: rule,
		});

		return root;
	}

	expand(rule: string, allowEscapeChars?: boolean) {
		var root = this.createRoot(rule);
		root.expand();
		if (!allowEscapeChars) root.clearEscapeChars();

		return root;
	}

	flatten(rule: string, allowEscapeChars?: boolean) {
		var root = this.expand(rule, allowEscapeChars);

		return root.finishedText;
	}

	toJSON() {
		var keys = Object.keys(this.symbols);
		var symbolJSON = [];
		for (var i = 0; i < keys.length; i++) {
			var key = keys[i];
			symbolJSON.push(' "' + key + '" : ' + this.symbols[key].rulesToJSON());
		}
		return '{\n' + symbolJSON.join(',\n') + '\n}';
	}

	// Create or push rules
	pushRules(key: string, rawRules: ConstructorParameters<typeof TracerySymbol>[2], sourceAction?: boolean) {
		if (this.symbols[key] === undefined) {
			this.symbols[key] = new TracerySymbol(this, key, rawRules);
			if (sourceAction) this.symbols[key].isDynamic = true;
		} else {
			this.symbols[key].pushRules(rawRules);
		}
	}

	popRules(key: string) {
		if (!this.symbols[key]) this.errors.push("Can't pop: no symbol for key " + key);
		this.symbols[key].popRules();
	}

	selectRule(key: string, node: TraceryNode, errors: string[]) {
		if (this.symbols[key]) {
			var rule = this.symbols[key].selectRule(node, errors);

			return rule;
		}

		// Failover to alternative subgrammars
		for (var i = 0; i < this.subgrammars.length; i++) {
			if (this.subgrammars[i].symbols[key]) return this.subgrammars[i].symbols[key].selectRule();
		}

		// No symbol?
		errors.push("No symbol for '" + key + "'");
		return '((' + key + '))';
	}
}

// Parses a plaintext rule in the tracery syntax
const tracery = {
	createGrammar: function (raw: ConstructorParameters<typeof TraceryGrammar>[0]) {
		return new TraceryGrammar(raw);
	},

	// Parse the contents of a tag
	parseTag: function (tagContents: string | null) {
		var parsed = {
			symbol: undefined,
			preactions: [],
			postactions: [],
			modifiers: [],
		};
		var sections = tracery.parse(tagContents);
		var symbolSection = undefined;
		for (var i = 0; i < sections.length; i++) {
			if (sections[i].type === 0) {
				if (symbolSection === undefined) {
					symbolSection = sections[i].raw;
				} else {
					throw 'multiple main sections in ' + tagContents;
				}
			} else {
				parsed.preactions.push(sections[i]);
			}
		}

		if (symbolSection === undefined) {
			//   throw ("no main section in " + tagContents);
		} else {
			var components = symbolSection.split('.');
			parsed.symbol = components[0];
			parsed.modifiers = components.slice(1);
		}
		return parsed;
	},

	parse: function (rule: string | null): ArrayWithErrors<Settings> {
		var depth = 0;
		var inTag = false;
		var sections = new ArrayWithErrors<Settings>();
		var escaped = false;

		var errors = new Array<string>();
		var start = 0;

		var escapedSubstring = '';
		var lastEscapedChar = undefined;

		if (rule === null) {
			var sections = new ArrayWithErrors<Settings>();
			sections.errors = errors;

			return sections;
		}

		function createSection(start, end, type) {
			if (end - start < 1) {
				if (type === 1) errors.push(start + ': empty tag');
				if (type === 2) errors.push(start + ': empty action');
			}
			var rawSubstring;
			if (lastEscapedChar !== undefined) {
				rawSubstring = escapedSubstring + '\\' + rule.substring(lastEscapedChar + 1, end);
			} else {
				rawSubstring = rule.substring(start, end);
			}
			sections.push({
				type: type,
				raw: rawSubstring,
			});
			lastEscapedChar = undefined;
			escapedSubstring = '';
		}

		for (var i = 0; i < rule.length; i++) {
			if (!escaped) {
				var c = rule.charAt(i);

				switch (c) {
					// Enter a deeper bracketed section
					case '[':
						if (depth === 0 && !inTag) {
							if (start < i) createSection(start, i, 0);
							start = i + 1;
						}
						depth++;
						break;

					case ']':
						depth--;

						// End a bracketed section
						if (depth === 0 && !inTag) {
							createSection(start, i, 2);
							start = i + 1;
						}
						break;

					// Hashtag
					//   ignore if not at depth 0, that means we are in a bracket
					case '#':
						if (depth === 0) {
							if (inTag) {
								createSection(start, i, 1);
								start = i + 1;
							} else {
								if (start < i) createSection(start, i, 0);
								start = i + 1;
							}
							inTag = !inTag;
						}
						break;

					case '\\':
						escaped = true;
						escapedSubstring = escapedSubstring + rule.substring(start, i);
						start = i + 1;
						lastEscapedChar = i;
						break;
				}
			} else {
				escaped = false;
			}
		}
		if (start < rule.length) createSection(start, rule.length, 0);

		if (inTag) {
			errors.push('Unclosed tag');
		}
		if (depth > 0) {
			errors.push('Too many [');
		}
		if (depth < 0) {
			errors.push('Too many ]');
		}

		// Strip out empty plaintext sections

		sections = sections.filter(function (section) {
			if (section.type === 0 && section.raw.length === 0) return false;
			return true;
		}) as ArrayWithErrors<Settings>;
		sections.errors = errors;
		return sections;
	},
	baseEngModifiers,
	TraceryNode,
	Grammar: TraceryGrammar,
	Symbol: TracerySymbol,
	RuleSet: TraceryRuleSet,
};

function isVowel(c) {
	var c2 = c.toLowerCase();
	return c2 === 'a' || c2 === 'e' || c2 === 'i' || c2 === 'o' || c2 === 'u';
}

function isAlphaNum(c) {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9');
}
function escapeRegExp(str) {
	return str.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1');
}

var baseEngModifiers = {
	replace: function (s: string, params: string[]) {
		//http://stackoverflow.com/questions/1144783/replacing-all-occurrences-of-a-string-in-javascript
		return s.replace(new RegExp(escapeRegExp(params[0]), 'g'), params[1]);
	},

	capitalizeAll: function (s: string) {
		var s2 = '';
		var capNext = true;
		for (var i = 0; i < s.length; i++) {
			if (!isAlphaNum(s.charAt(i))) {
				capNext = true;
				s2 += s.charAt(i);
			} else {
				if (!capNext) {
					s2 += s.charAt(i);
				} else {
					s2 += s.charAt(i).toUpperCase();
					capNext = false;
				}
			}
		}
		return s2;
	},

	capitalize: function (s: string) {
		return s.charAt(0).toUpperCase() + s.substring(1);
	},

	a: function (s: string) {
		if (s.length > 0) {
			if (s.charAt(0).toLowerCase() === 'u') {
				if (s.length > 2) {
					if (s.charAt(2).toLowerCase() === 'i') return 'a ' + s;
				}
			}

			if (isVowel(s.charAt(0))) {
				return 'an ' + s;
			}
		}

		return 'a ' + s;
	},

	firstS: function (s: string) {
		console.log(s);
		var s2 = s.split(' ');

		var finished = baseEngModifiers.s(s2[0]) + ' ' + s2.slice(1).join(' ');
		console.log(finished);
		return finished;
	},

	s: function (s: string) {
		switch (s.charAt(s.length - 1)) {
			case 's':
				return s + 'es';
				break;
			case 'h':
				return s + 'es';
				break;
			case 'x':
				return s + 'es';
				break;
			case 'y':
				if (!isVowel(s.charAt(s.length - 2))) return s.substring(0, s.length - 1) + 'ies';
				else return s + 's';
				break;
			default:
				return s + 's';
		}
	},
	ed: function (s: string) {
		switch (s.charAt(s.length - 1)) {
			case 's':
				return s + 'ed';
				break;
			case 'e':
				return s + 'd';
				break;
			case 'h':
				return s + 'ed';
				break;
			case 'x':
				return s + 'ed';
				break;
			case 'y':
				if (!isVowel(s.charAt(s.length - 2))) return s.substring(0, s.length - 1) + 'ied';
				else return s + 'd';
				break;
			default:
				return s + 'ed';
		}
	},
};

module.exports = tracery;

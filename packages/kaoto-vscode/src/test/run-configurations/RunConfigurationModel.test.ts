import { assert } from 'chai';
import {
	formatCommandLine,
	formatEnvironment,
	getAction,
	KAOTO_DEBUG_TYPE,
	parseCommandLine,
	parseEnvironment,
	parseList,
	quoteArgument,
	splitArguments,
} from '../../run-configurations/RunConfigurationModel';

suite('RunConfigurationModel', () => {
	suite('splitArguments', () => {
		test('should move the options that have their own field out of the arguments', () => {
			const result = splitArguments(['--dev', '--logging-level=debug', '--cluster-type=kind', '*.xsl']);

			assert.deepEqual(result, { dev: true, loggingLevel: 'debug', clusterType: 'kind', args: ['*.xsl'] });
		});

		test('should read an explicit dev value', () => {
			assert.isTrue(splitArguments(['--dev=true']).dev);
			assert.isFalse(splitArguments(['--dev=false']).dev);
		});

		test('should return no options for no arguments', () => {
			assert.deepEqual(splitArguments(), { args: [] });
		});
	});

	suite('parseCommandLine', () => {
		test('should split on whitespace', () => {
			assert.deepEqual(parseCommandLine('  --dev   --console\t*.xsl '), ['--dev', '--console', '*.xsl']);
		});

		test('should keep quoted parts together', () => {
			assert.deepEqual(parseCommandLine(`--name="my route" '--repos=a b'`), ['--name=my route', '--repos=a b']);
		});

		test('should keep an empty quoted argument', () => {
			assert.deepEqual(parseCommandLine(`--prop ''`), ['--prop', '']);
		});
	});

	suite('formatCommandLine', () => {
		test('should leave plain arguments and variables unquoted', () => {
			assert.strictEqual(
				formatCommandLine(['--dev', '${workspaceFolder}/a.camel.yaml', '--management-port=<free-port>']),
				'--dev ${workspaceFolder}/a.camel.yaml --management-port=<free-port>',
			);
		});

		test('should quote arguments that a shell would split or expand', () => {
			assert.strictEqual(formatCommandLine(['--name=my route', '*.xsl', '--repos=#repos']), `'--name=my route' '*.xsl' '--repos=#repos'`);
		});

		test('should parse back what it formats', () => {
			const args = ['--name=my route', '', '--dev'];

			assert.deepEqual(parseCommandLine(formatCommandLine(args)), args);
		});
	});

	suite('quoteArgument', () => {
		test('should escape single quotes', () => {
			assert.strictEqual(quoteArgument(`it's`), `'it'\\''s'`);
		});

		test('should quote an empty argument', () => {
			assert.strictEqual(quoteArgument(''), "''");
		});
	});

	suite('environment', () => {
		test('should parse KEY=value lines and skip comments and blank lines', () => {
			const env = parseEnvironment('# broker\nCAMEL_KAFKA_BROKERS=localhost:9092\n\n  JAVA_OPTS=-Da=b  \nINVALID\n');

			assert.deepEqual(env, { CAMEL_KAFKA_BROKERS: 'localhost:9092', JAVA_OPTS: '-Da=b' });
		});

		test('should format one variable per line', () => {
			assert.strictEqual(formatEnvironment({ A: '1', B: '2' }), 'A=1\nB=2');
			assert.strictEqual(formatEnvironment(), '');
		});
	});

	suite('parseList', () => {
		test('should split on commas and new lines and drop empty entries', () => {
			assert.deepEqual(parseList('a.properties, b.properties\n\nc.properties,'), ['a.properties', 'b.properties', 'c.properties']);
		});
	});

	suite('getAction', () => {
		test('should default to run', () => {
			assert.strictEqual(getAction({ type: KAOTO_DEBUG_TYPE, request: 'launch', name: 'Run' }), 'run');
			assert.strictEqual(getAction({ type: KAOTO_DEBUG_TYPE, request: 'launch', name: 'Export', action: 'export' }), 'export');
		});
	});
});

const { logger, file, csv } = require('../core')
const { program } = require('commander')
const schemes = require('./schemes')
const chalk = require('chalk')
const Joi = require('joi')
const _ = require('lodash')

program.argument('[filepath]', 'Path to file to validate').parse(process.argv)

const allFiles = [
	'data/blocklist.csv',
	'data/categories.csv',
	'data/channels.csv',
	'data/countries.csv',
	'data/languages.csv',
	'data/regions.csv',
	'data/subdivisions.csv'
]

let db = {}
let files = {}

async function main() {
	let globalErrors = []

	for (let filepath of allFiles) {
		if (!filepath.endsWith('.csv')) continue

		const eol = await file.eol(filepath)
		if (eol !== 'CRLF')
			return handleError(`Error: file must have line endings with CRLF (${filepath})`)

		const csvString = await file.read(filepath)
		if (/\s+$/.test(csvString))
			return handleError(`Error: empty lines at the end of file not allowed (${filepath})`)

		const rows = csvString.split('\r\n')
		const headers = rows[0].split(',')
		for (let [i, line] of rows.entries()) {
			if (line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).length !== headers.length)
				return handleError(`Error: row ${i + 1} has the wrong number of columns (${filepath})`)
		}

		const filename = file.getFilename(filepath)
		let data = await csv
			.fromString(csvString)
			.catch(err => handleError(`${err.message} (${filepath})`))

		let grouped
		switch (filename) {
			case 'blocklist':
				grouped = _.keyBy(data, 'channel')
				break
			case 'categories':
			case 'channels':
				grouped = _.keyBy(data, 'id')
				break
			default:
				grouped = _.keyBy(data, 'code')
				break
		}

		db[filename] = grouped
		files[filename] = data
	}

	const toCheck = program.args.length ? program.args : allFiles
	for (const filepath of toCheck) {
		const filename = file.getFilename(filepath)
		if (!schemes[filename]) return handleError(`Error: "${filename}" scheme is missing`)

		const rows = files[filename]

		let fileErrors = []
		if (filename === 'channels') {
			fileErrors = fileErrors.concat(findDuplicatesById(rows))
			for (const [i, row] of rows.entries()) {
				fileErrors = fileErrors.concat(validateChannelBroadcastArea(row, i))
				fileErrors = fileErrors.concat(validateChannelSubdivision(row, i))
				fileErrors = fileErrors.concat(validateChannelCategories(row, i))
				fileErrors = fileErrors.concat(validateChannelReplacedBy(row, i))
				fileErrors = fileErrors.concat(validateChannelLanguages(row, i))
				fileErrors = fileErrors.concat(validateChannelCountry(row, i))
			}
		} else if (filename === 'blocklist') {
			for (const [i, row] of rows.entries()) {
				fileErrors = fileErrors.concat(validateChannelId(row, i))
			}
		} else if (filename === 'countries') {
			for (const [i, row] of rows.entries()) {
				fileErrors = fileErrors.concat(validateCountryLanguage(row, i))
			}
		} else if (filename === 'subdivisions') {
			for (const [i, row] of rows.entries()) {
				fileErrors = fileErrors.concat(validateSubdivisionCountry(row, i))
			}
		} else if (filename === 'regions') {
			for (const [i, row] of rows.entries()) {
				fileErrors = fileErrors.concat(validateRegionCountries(row, i))
			}
		}

		const schema = Joi.object(schemes[filename])
		rows.forEach((row, i) => {
			const { error } = schema.validate(row, { abortEarly: false })
			if (error) {
				error.details.forEach(detail => {
					fileErrors.push({ line: i + 2, message: detail.message })
				})
			}
		})

		if (fileErrors.length) {
			logger.info(`\n${chalk.underline(filepath)}`)
			fileErrors.forEach(err => {
				const position = err.line.toString().padEnd(6, ' ')
				logger.info(` ${chalk.gray(position)} ${err.message}`)
			})
			globalErrors = globalErrors.concat(fileErrors)
		}
	}

	if (globalErrors.length) return handleError(`${globalErrors.length} error(s)`)
}

main()

function findDuplicatesById(rows) {
	rows = rows.map(row => {
		row.id = row.id.toLowerCase()

		return row
	})

	const errors = []
	const schema = Joi.array().unique((a, b) => a.id === b.id)
	const { error } = schema.validate(rows, { abortEarly: false })
	if (error) {
		error.details.forEach(detail => {
			errors.push({
				line: detail.context.pos + 2,
				message: `entry with the id "${detail.context.value.id}" already exists`
			})
		})
	}

	return errors
}

// function findDuplicatesByName(rows) {
// 	rows = rows.map(row => {
// 		row.name = row.name.toLowerCase()

// 		return row
// 	})

// 	const errors = []
// 	const schema = Joi.array().unique((a, b) => a.name === b.name)
// 	const { error } = schema.validate(rows, { abortEarly: false })
// 	if (error) {
// 		error.details.forEach(detail => {
// 			errors.push({
// 				line: detail.context.pos + 2,
// 				message: `entry with the name "${detail.context.value.name}" already exists`
// 			})
// 		})
// 	}

// 	return errors
// }

function validateChannelCategories(row, i) {
	const errors = []
	row.categories.forEach(category => {
		if (!db.categories[category]) {
			errors.push({
				line: i + 2,
				message: `"${row.id}" has the wrong category "${category}"`
			})
		}
	})

	return errors
}

function validateChannelCountry(row, i) {
	const errors = []
	if (!db.countries[row.country]) {
		errors.push({
			line: i + 2,
			message: `"${row.id}" has the wrong country "${row.country}"`
		})
	}

	return errors
}

function validateChannelReplacedBy(row, i) {
	const errors = []
	if (row.replaced_by && !db.channels[row.replaced_by]) {
		errors.push({
			line: i + 2,
			message: `"${row.id}" has the wrong replaced_by "${row.replaced_by}"`
		})
	}

	return errors
}

function validateChannelSubdivision(row, i) {
	const errors = []
	if (row.subdivision && !db.subdivisions[row.subdivision]) {
		errors.push({
			line: i + 2,
			message: `"${row.id}" has the wrong subdivision "${row.subdivision}"`
		})
	}

	return errors
}

function validateChannelBroadcastArea(row, i) {
	const errors = []
	row.broadcast_area.forEach(area => {
		const [type, code] = area.split('/')
		if (
			(type === 'r' && !db.regions[code]) ||
			(type === 'c' && !db.countries[code]) ||
			(type === 's' && !db.subdivisions[code])
		) {
			errors.push({
				line: i + 2,
				message: `"${row.id}" has the wrong broadcast_area "${area}"`
			})
		}
	})

	return errors
}

function validateChannelLanguages(row, i) {
	const errors = []
	row.languages.forEach(language => {
		if (!db.languages[language]) {
			errors.push({
				line: i + 2,
				message: `"${row.id}" has the wrong language "${language}"`
			})
		}
	})

	return errors
}

function validateChannelId(row, i) {
	const errors = []
	if (!db.channels[row.channel]) {
		errors.push({
			line: i + 2,
			message: `"${row.channel}" is missing in the channels.csv`
		})
	}

	return errors
}

function validateCountryLanguage(row, i) {
	const errors = []
	if (!db.languages[row.lang]) {
		errors.push({
			line: i + 2,
			message: `"${row.code}" has the wrong language "${row.lang}"`
		})
	}

	return errors
}

function validateSubdivisionCountry(row, i) {
	const errors = []
	if (!db.countries[row.country]) {
		errors.push({
			line: i + 2,
			message: `"${row.code}" has the wrong country "${row.country}"`
		})
	}

	return errors
}

function validateRegionCountries(row, i) {
	const errors = []
	row.countries.forEach(country => {
		if (!db.countries[country]) {
			errors.push({
				line: i + 2,
				message: `"${row.code}" has the wrong country "${country}"`
			})
		}
	})

	return errors
}

function handleError(message) {
	logger.error(chalk.red(`\n${message}`))
	process.exit(1)
}

import cliProgress from 'cli-progress'
import chalk from 'chalk'

class Logger {
  private progressBar: cliProgress.SingleBar | null = null
  private startTimes: Map<string, number> = new Map()

  constructor() {
    this.progressBar = null
  }

  private getTimestamp(): string {
    return new Date().toISOString().split('T')[1].slice(0, -1)
  }

  sectionStart(section: string): void {
    this.startTimes.set(section, Date.now())
    console.log(`\n${chalk.blue('►')} ${chalk.bold(section)}`)
  }

  sectionEnd(section: string, startTime: number): void {
    const duration = Date.now() - startTime
    if (this.progressBar) {
      this.progressBar.stop()
      this.progressBar = null
    }
    console.log(
      `${chalk.green('✓')} ${chalk.bold(section)} completed in ${chalk.cyan(
        `${duration}ms`
      )}\n`
    )
  }

  startProgress(total: number): void {
    if (this.progressBar) {
      this.progressBar.stop()
    }

    this.progressBar = new cliProgress.SingleBar({
      format: `${chalk.blue('{')} {bar} ${chalk.blue(
        '}'
      )} {percentage}% | {value}/{total} items | {status}`,
      barCompleteChar: '=',
      barIncompleteChar: '-',
      hideCursor: true,
    })

    this.progressBar.start(total, 0, { status: 'Processing...' })
  }

  updateProgress(current: number, status?: string): void {
    if (this.progressBar) {
      this.progressBar.update(current, { status: status || 'Processing...' })
    }
  }

  error(message: string, error: unknown): void {
    if (this.progressBar) {
      this.progressBar.stop()
      this.progressBar = null
    }
    console.error(
      `${chalk.red('✖')} ${chalk.bold('ERROR:')} ${message}`,
      error instanceof Error ? error.message : error
    )
  }

  api(message: string, data?: unknown): void {
    if (process.env.DEBUG) {
      const timestamp = this.getTimestamp()
      console.log(
        `${chalk.gray(timestamp)} ${chalk.blue('api')} ${message}`,
        data || ''
      )
    }
  }

  prisma(message: string, data?: unknown): void {
    if (process.env.DEBUG) {
      const timestamp = this.getTimestamp()
      console.log(
        `${chalk.gray(timestamp)} ${chalk.magenta('db')} ${message}`,
        data || ''
      )
    }
  }

  progress(message: string): void {
    this.updateProgress(0, message)
  }

  debug(message: string, data?: unknown): void {
    if (process.env.DEBUG) {
      const timestamp = this.getTimestamp()
      console.debug(
        `${chalk.gray(timestamp)} ${chalk.gray('debug')} ${message}`,
        data || ''
      )
    }
  }
}

export default new Logger()
